import crypto from 'node:crypto';
import express from 'express';
import { config, conversationKey } from './config.js';
import { router as webhookRouter } from './webhook.js';
import { ensureIndex, indexStats } from './kb.js';
import { activeHandovers, resume } from './handover.js';
import { conversation } from './conversations.js';
import { check as checkWacrm } from './wacrm.js';

export const app = express();
app.disable('x-powered-by');

// The webhook brings its own raw-body parser, so it is mounted before the JSON one.
app.use('/webhooks', webhookRouter);
app.use(express.json({ limit: '100kb' }));

/** Public and cheap: is the process up, is the knowledge base loaded, is the bot gated? */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    kb: indexStats(),
    allowlistMode: config.bot.allowlist.size > 0,
    webhookSigned: Boolean(config.wacrm.webhookSecret),
  });
});

/* -------------------------------- admin -------------------------------- */

function requireAdmin(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN is not set — admin routes are off' });
  const given = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(config.adminToken);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/status', async (_req, res) => {
  res.json({ kb: indexStats(), wacrm: await checkWacrm(), handovers: activeHandovers(), allowlist: [...config.bot.allowlist] });
});

/** Re-reads knowledge/ and re-embeds anything that changed. */
admin.post('/reindex', async (_req, res) => {
  try {
    await ensureIndex({ force: true, log: (m) => console.log(`[kb] ${m}`) });
    res.json({ ok: true, kb: indexStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

admin.get('/handovers', (_req, res) => res.json(activeHandovers()));

/** Hands a chat back to the bot before HANDOVER_HOURS runs out. */
admin.post('/handover/:waId/resume', async (req, res) => {
  const key = conversationKey(req.params.waId);
  await resume(key);
  res.json({ ok: true, waId: key });
});

admin.get('/conversations/:waId', async (req, res) => {
  res.json(await conversation(conversationKey(req.params.waId)));
});

app.use('/admin', admin);
