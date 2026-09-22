import { config, conversationKey } from '../config.js';
import { collection } from '../store/mongo.js';

/**
 * Human handover. When the bot cannot answer, or a staff member replies from the wacrm inbox,
 * the bot goes silent for that contact for HANDOVER_HOURS so a person can own the chat.
 * Kept in memory for the hot path and mirrored to MongoDB so a restart cannot put the bot
 * back into a chat staff are handling. Ported from wati_chat-bot/src/handover.js.
 */
const pausedUntil = new Map(); // contact key -> ms
/**
 * Who started each hold: 'bot' when it could not answer, 'staff' when a person replied from the
 * inbox. A hold saved before this was recorded counts as staff, so the bot never talks over them.
 */
const pausedBy = new Map(); // contact key -> 'bot' | 'staff'
let loaded = false;

const remember = (key, doc) => {
  pausedUntil.set(key, doc ? new Date(doc.pausedUntil).getTime() : 0);
  pausedBy.set(key, doc?.by ?? 'staff');
};

async function save(key, until, by) {
  try {
    const handovers = await collection('handovers');
    if (until) {
      await handovers.updateOne(
        { waId: key },
        { $set: { waId: key, pausedUntil: new Date(until), by, updatedAt: new Date() } },
        { upsert: true }
      );
    } else {
      await handovers.deleteOne({ waId: key });
    }
  } catch (err) {
    console.error('handover save failed:', err.message);
  }
}

/**
 * Pauses the bot for this contact, starting now (restarts the clock if already paused).
 * `by` is 'bot' when the bot handed the question over, 'staff' when a person replied.
 */
export async function pauseForHandover(waId, { by = 'bot' } = {}) {
  const key = conversationKey(waId);
  if (!key) return;
  const until = Date.now() + config.bot.handoverMs;
  pausedUntil.set(key, until);
  pausedBy.set(key, by);
  await save(key, until, by);
}

/**
 * Is a person handling this chat? A failed lookup answers "no": a student left unanswered is
 * worse than the bot speaking once in a chat staff are on.
 */
export async function isPaused(waId) {
  return Boolean(await heldBy(waId));
}

/** Who holds this chat right now: 'bot', 'staff', or null when the bot is free to answer. */
export async function heldBy(waId) {
  const key = conversationKey(waId);
  if (!key) return null;
  if (!pausedUntil.has(key) && !loaded) {
    try {
      remember(key, await (await collection('handovers')).findOne({ waId: key }));
    } catch (err) {
      console.error('handover lookup failed:', err.message);
      return null;
    }
  }
  return (pausedUntil.get(key) ?? 0) > Date.now() ? pausedBy.get(key) ?? 'staff' : null;
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
  return [...pausedUntil]
    .filter(([, until]) => until > now)
    .map(([waId, until]) => ({ waId, pausedUntil: new Date(until), by: pausedBy.get(waId) ?? 'staff' }));
}

/** Warms the cache at boot; returns how many chats are with a person right now. */
export async function loadHandovers() {
  try {
    const docs = await (await collection('handovers')).find({}).toArray();
    for (const doc of docs) remember(doc.waId, doc);
    loaded = true;
  } catch (err) {
    console.error('handover load failed:', err.message);
  }
  return activeHandovers().length;
}

/** Tests only. */
export function _resetHandoverCache() {
  pausedUntil.clear();
  pausedBy.clear();
  loaded = false;
}
