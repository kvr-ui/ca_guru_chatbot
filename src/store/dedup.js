import { collection } from './mongo.js';

/**
 * wacrm delivers "best-effort, single attempt", and the docs warn the same event can still
 * arrive twice. Ids are remembered in memory and in MongoDB (a week, TTL index), and the unique
 * index makes the database the arbiter across restarts.
 */
const seen = new Map(); // id -> timestamp
const MEMORY_MS = 10 * 60_000;

/** True the first time an event id is seen. */
export async function isNewEvent(eventId) {
  if (!eventId) return true;
  const id = String(eventId);
  const now = Date.now();
  for (const [key, ts] of seen) if (now - ts > MEMORY_MS) seen.delete(key);
  if (seen.has(id)) return false;
  seen.set(id, now);

  try {
    await (await collection('webhook_events')).insertOne({ eventId: id, createdAt: new Date(now) });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    // Database down: memory has already ruled out a repeat within this process.
    console.error('webhook de-duplication save failed:', err.message);
    return true;
  }
}
