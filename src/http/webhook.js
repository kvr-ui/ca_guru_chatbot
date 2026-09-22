// POST /webhooks/wacrm — how the bot hears from students.
//
// Mounted before any global body parser: wacrm signs the RAW body, so this router keeps the
// bytes it parses. Pattern from drip_engine/src/routes/webhooks.js.

import fs from 'node:fs';
import express from 'express';
import { config, contactKey } from '../config.js';
import { verifySignature } from './signature.js';
import { isNewEvent } from '../store/dedup.js';
import { handleMessage } from '../bot/handler.js';
import { deliver, onMessageSent } from '../whatsapp/outbox.js';
import { logTurn } from '../store/conversations.js';
import { triggerEnabled, hasTrigger, isActivated, activate } from '../bot/activation.js';

export const router = express.Router();

router.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

function capture(req, verdict) {
  if (!config.wacrm.captureFile) return;
  const line = JSON.stringify({ at: new Date().toISOString(), verdict, body: req.body });
  fs.appendFile(config.wacrm.captureFile, `${line}\n`, (err) => {
    if (err) console.error('webhook capture failed:', err.message);
  });
}

router.post('/wacrm', (req, res) => {
  const check = verifySignature(req.rawBody || '', req.get('X-Wacrm-Signature'));
  // Setup escape hatch: wacrm shows the secret once, and an endpoint that 401s every event is
  // auto-disabled. Only reachable while the secret is genuinely unset.
  const unsignedOk = !config.wacrm.webhookSecret && config.wacrm.webhookAllowUnsigned;

  if (!check.ok && !unsignedOk) {
    capture(req, `rejected: ${check.reason}`);
    console.warn(`rejected wacrm webhook: ${check.reason}`);
    return res.status(401).json({ error: check.reason });
  }
  capture(req, check.ok ? 'verified' : 'UNVERIFIED (setup mode)');
  if (!check.ok) console.warn('accepting an UNVERIFIED webhook — setup mode; set WACRM_WEBHOOK_SECRET');

  // ACK before any work: wacrm makes one attempt and disables endpoints that keep failing.
  res.status(200).json({ ok: true });

  const payload = req.body;
  setImmediate(() => {
    handleEvent(payload).catch((err) => console.error('webhook processing failed:', err));
  });
});

/**
 * One contact's messages are handled strictly in order, so two quick questions get their
 * answers in the order they were asked and the second one sees the first in its history.
 */
const queues = new Map();
function inOrder(key, task) {
  const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/** Everything a webhook can carry. Exported for tests. */
export async function handleEvent(payload) {
  const type = payload?.event;
  const data = payload?.data || {};
  if (!(await isNewEvent(payload?.id || data.whatsapp_message_id))) return { skipped: 'duplicate' };

  if (type === 'message.sent') return { sent: await onMessageSent(data) };
  if (type !== 'message.received') return { skipped: type || 'unknown' };

  const waId = contactKey(data.wa_id || data.phone);
  if (!waId) return { skipped: 'no_phone' };

  const event = {
    waId,
    name: data.sender_name || data.contact_name || null,
    text: data.text || '',
    type: data.content_type || 'text',
  };

  // Staged launch: while BOT_ALLOWLIST is set, only those numbers are answered.
  if (config.bot.allowlist.size && !config.bot.allowlist.has(waId)) {
    await logTurn({ waId, name: event.name, text: event.text, meta: { reason: 'not_allowlisted', type: event.type } });
    return { skipped: 'not_allowlisted' };
  }

  // Only leads who sent the trigger phrase get the bot; everyone else stays with the team.
  if (triggerEnabled() && !(await isActivated(waId))) {
    if (!hasTrigger(event.text)) {
      await logTurn({ waId, name: event.name, text: event.text, meta: { reason: 'not_triggered', type: event.type } });
      return { skipped: 'not_triggered' };
    }
    // A brand-new lead gets the qualifying questions before anything else.
    event.justActivated = await activate(waId, { name: event.name, text: event.text });
  }

  return inOrder(waId, async () => {
    const { replies, meta } = await handleMessage(event);
    for (const reply of replies) await deliver(waId, reply);
    return { reason: meta.reason, replies: replies.length };
  });
}
