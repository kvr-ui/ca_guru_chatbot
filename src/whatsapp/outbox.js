import { contactKey } from '../config.js';
import { collection } from '../store/mongo.js';
import { sendText, MAX_TEXT } from './wacrm.js';
import { pauseForHandover } from '../bot/handover.js';

/**
 * Sending, and telling our own sends apart from staff replies.
 *
 * wacrm fires `message.sent` for EVERY outbound message on the account — the bot's API sends
 * and a person typing in the wacrm inbox alike, both stamped `sender_type: "agent"`. The only
 * way to know a person has stepped in is that the wamid is not one this bot sent.
 *
 * Two races make that harder than a lookup:
 *  - the webhook can arrive before sendText() has returned the wamid, so the text is noted as
 *    pending BEFORE the request goes out;
 *  - the event can still beat the insert into `sent`, so an unknown wamid is checked again
 *    after STAFF_CONFIRM_MS before it is believed.
 */
const PENDING_MS = 2 * 60_000;
export const STAFF_CONFIRM_MS = Number(process.env.STAFF_CONFIRM_MS ?? 5000);
const RETRY_CAP_MS = 30_000;

const pending = new Map(); // contact key -> [{ text, at }]

function notePending(key, text) {
  const now = Date.now();
  const list = (pending.get(key) ?? []).filter((p) => now - p.at < PENDING_MS);
  // Same trim as sendText(), so it matches the text wacrm echoes back.
  list.push({ text: String(text).trim().slice(0, MAX_TEXT), at: now });
  pending.set(key, list);
}

function wasPending(key, text) {
  const now = Date.now();
  const body = String(text ?? '').trim();
  return (pending.get(key) ?? []).some((p) => now - p.at < PENDING_MS && p.text === body);
}

async function recordSent(key, wamid) {
  if (!wamid) return;
  try {
    await (await collection('sent')).updateOne(
      { wamid },
      { $setOnInsert: { wamid, waId: key, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('sent-message record failed:', err.message);
  }
}

async function isOurWamid(wamid) {
  if (!wamid) return false;
  try {
    return Boolean(await (await collection('sent')).findOne({ wamid }));
  } catch {
    // Can't tell: assume ours. A missed staff reply costs one extra bot message; a false one
    // silences the bot for HANDOVER_HOURS.
    return true;
  }
}

/** Sends one reply, honouring a 429 once. Returns the wacrm result. */
export async function deliver(waId, text) {
  const key = contactKey(waId);
  notePending(key, text);
  let result = await sendText(key, text);
  if (!result.ok && result.code === 'rate_limited') {
    await new Promise((r) => setTimeout(r, Math.min(result.retryAfterMs ?? 60_000, RETRY_CAP_MS)));
    result = await sendText(key, text);
  }
  if (result.ok) await recordSent(key, result.id);
  else console.error(`send to ${key} failed: ${result.error}`);
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A `message.sent` event. If a person sent it, the bot hands the chat over to them.
 * @returns {Promise<'ours'|'staff'|'ignored'>}
 */
export async function onMessageSent(data = {}) {
  const key = contactKey(data.wa_id || data.phone);
  if (!key) return 'ignored';
  const wamid = data.whatsapp_message_id || null;

  const ours = () => wasPending(key, data.text) || isOurWamid(wamid);
  if (await ours()) return 'ours';
  await sleep(STAFF_CONFIRM_MS);
  if (await ours()) return 'ours';

  console.log(`staff replied to ${key} from the inbox — bot paused for this chat`);
  await pauseForHandover(key, { by: 'staff' });
  return 'staff';
}

/** Tests only. */
export function _resetOutbox() {
  pending.clear();
}
