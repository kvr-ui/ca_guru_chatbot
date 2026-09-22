import { conversationKey } from '../config.js';
import { collection } from '../store/mongo.js';

/**
 * Students who sent STOP. Nothing they send afterwards is answered, except START, which opts
 * them back in. Kept in memory and mirrored to MongoDB so a restart cannot start replying to
 * someone who asked us to stop. Detection ported from wati_chat-bot/src/optout.js.
 */
const optedOut = new Set();

/** Lowercase, apostrophes dropped ("don't" -> "dont"), everything else that is not a letter or digit a space. */
const normalize = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const FILLER = '(?:please|pls|plz|kindly|ok|okay|sir|madam|mam|maam|bro|now|just|thanks|thank you|thankyou)';
const REQUEST = [
  'stop',
  'stop (?:it|this|that|now|all)',
  'stop (?:messaging|texting|sending|spamming|contacting|msging|msg|message|bothering|disturbing)(?: (?:me|us|messages|msgs|texts|this|these))?(?: (?:again|anymore|any more))?',
  'stop (?:the|these|this|your|all|all these|all the)? ?(?:whatsapp )?(?:messages|message|msgs|msg|texts|spam)',
  '(?:unsubscribe|unsub)(?: me)?',
  'opt ?out',
  'opt me out',
  '(?:dont|do not|never) (?:message|msg|text|contact|disturb|send) (?:me|us)(?: (?:again|anymore|any more|messages))?',
  'no more (?:messages|message|msgs|texts|spam)',
].join('|');
const OPT_OUT_RE = new RegExp(`^(?:${FILLER} )*(?:${REQUEST})(?: ${FILLER})*$`);
const OPT_IN_RE = /^(?:start|unstop|resume|subscribe)$/;

/**
 * True only when the whole message asks us to stop. "How do I stop auto-renewal?" is a question
 * and must be answered.
 */
export const isOptOutRequest = (text) => OPT_OUT_RE.test(normalize(text));
export const isOptInRequest = (text) => OPT_IN_RE.test(normalize(text));

/**
 * Fails closed for real numbers: if the database is unreachable the contact is treated as
 * opted out rather than risk messaging someone who asked us to stop.
 */
export async function isOptedOut(waId) {
  const key = conversationKey(waId);
  if (!key) return false;
  if (optedOut.has(key)) return true;
  try {
    const found = await (await collection('optouts')).findOne({ waId: key });
    if (found) optedOut.add(key);
    return Boolean(found);
  } catch (err) {
    console.error('opt-out lookup failed:', err.message);
    return !key.startsWith('cli:');
  }
}

/** Memory first, so the contact is silenced even if the save fails. */
export async function optOut(waId, { name = null, text = '' } = {}) {
  const key = conversationKey(waId);
  if (!key) return;
  optedOut.add(key);
  try {
    await (await collection('optouts')).updateOne(
      { waId: key },
      { $setOnInsert: { waId: key, name, text, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('opt-out save failed:', err.message);
  }
}

export async function optIn(waId) {
  const key = conversationKey(waId);
  if (!key) return;
  try {
    await (await collection('optouts')).deleteOne({ waId: key });
    optedOut.delete(key);
  } catch (err) {
    // Stay opted out: better one missed START than un-silencing on a failed write.
    console.error('opt-in save failed:', err.message);
    throw err;
  }
}

/** Warms the cache at boot; returns how many contacts have opted out. */
export async function loadOptOuts() {
  try {
    const docs = await (await collection('optouts')).find({}, { projection: { waId: 1 } }).toArray();
    for (const doc of docs) optedOut.add(doc.waId);
  } catch (err) {
    console.error('opt-out load failed:', err.message);
  }
  return optedOut.size;
}

/** Tests only. */
export function _resetOptOutCache() {
  optedOut.clear();
}
