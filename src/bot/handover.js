import { config, conversationKey } from '../config.js';
import { collection } from '../store/mongo.js';

/**
 * Human handover. When the bot cannot answer, or a staff member replies from the wacrm inbox,
 * the bot goes silent for that contact for HANDOVER_HOURS so a person can own the chat.
 * Kept in memory for the hot path and mirrored to MongoDB so a restart cannot put the bot
 * back into a chat staff are handling. Ported from wati_chat-bot/src/handover.js.
 */
const pausedUntil = new Map(); // contact key -> ms
let loaded = false;

async function save(key, until) {
  try {
    const handovers = await collection('handovers');
    if (until) {
      await handovers.updateOne(
        { waId: key },
        { $set: { waId: key, pausedUntil: new Date(until), updatedAt: new Date() } },
        { upsert: true }
      );
    } else {
      await handovers.deleteOne({ waId: key });
    }
  } catch (err) {
    console.error('handover save failed:', err.message);
  }
}

/** Pauses the bot for this contact, starting now (restarts the clock if already paused). */
export async function pauseForHandover(waId) {
  const key = conversationKey(waId);
  if (!key) return;
  const until = Date.now() + config.bot.handoverMs;
  pausedUntil.set(key, until);
  await save(key, until);
}

/**
 * Is a person handling this chat? A failed lookup answers "no": a student left unanswered is
 * worse than the bot speaking once in a chat staff are on.
 */
export async function isPaused(waId) {
  const key = conversationKey(waId);
  if (!key) return false;
  if (pausedUntil.has(key) || loaded) return (pausedUntil.get(key) ?? 0) > Date.now();
  try {
    const doc = await (await collection('handovers')).findOne({ waId: key });
    const until = doc ? new Date(doc.pausedUntil).getTime() : 0;
    pausedUntil.set(key, until);
    return until > Date.now();
  } catch (err) {
    console.error('handover lookup failed:', err.message);
    return false;
  }
}

/** Hands the chat back to the bot (admin route or terminal reset). */
export async function resume(waId) {
  const key = conversationKey(waId);
  if (!key) return;
  pausedUntil.set(key, 0);
  await save(key, 0);
}

/** Chats with a person right now. */
export function activeHandovers() {
  const now = Date.now();
  return [...pausedUntil].filter(([, until]) => until > now).map(([waId, until]) => ({ waId, pausedUntil: new Date(until) }));
}

/** Warms the cache at boot; returns how many chats are with a person right now. */
export async function loadHandovers() {
  try {
    const docs = await (await collection('handovers')).find({}).toArray();
    for (const doc of docs) pausedUntil.set(doc.waId, new Date(doc.pausedUntil).getTime());
    loaded = true;
  } catch (err) {
    console.error('handover load failed:', err.message);
  }
  return activeHandovers().length;
}

/** Tests only. */
export function _resetHandoverCache() {
  pausedUntil.clear();
  loaded = false;
}
