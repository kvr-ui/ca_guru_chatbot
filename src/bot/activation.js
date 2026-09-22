import { config, conversationKey } from '../config.js';
import { collection } from '../store/mongo.js';

/**
 * Leads the bot has been switched on for. The bot only talks to a contact after they send the
 * trigger phrase (BOT_TRIGGER_PHRASE, the ad's prefilled text); everyone else is left to the
 * team. Once a contact has sent it, every later message is answered too. Kept in memory and
 * mirrored to MongoDB so a restart does not forget who is a lead.
 */
const activated = new Set();

/** Same normalisation as opt-outs: case, punctuation and spacing never break a match. */
const normalize = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const phrase = () => normalize(config.bot.triggerPhrase);

/** Blank BOT_TRIGGER_PHRASE = no gate: every contact is answered. */
export const triggerEnabled = () => Boolean(phrase());

/** True when the message contains the trigger phrase anywhere, as whole words. */
export function hasTrigger(text) {
  const p = phrase();
  return Boolean(p) && ` ${normalize(text)} `.includes(` ${p} `);
}

/** True when the message is nothing but the trigger phrase, so there is no question to answer. */
export const isTriggerOnly = (text) => triggerEnabled() && normalize(text) === phrase();

/** The message with the trigger phrase taken out, normalised: "Hi, YOUR LAST ATTEMPT!" -> "hi". */
export function withoutTrigger(text) {
  const p = phrase();
  const n = normalize(text);
  return p ? ` ${n} `.replace(` ${p} `, ' ').trim() : n;
}

/**
 * Fails open to "not activated": if the database is unreachable an unknown contact is left to
 * the team rather than the bot answering someone who never sent the phrase.
 */
export async function isActivated(waId) {
  const key = conversationKey(waId);
  if (!key) return false;
  if (activated.has(key)) return true;
  try {
    const found = await (await collection('activations')).findOne({ waId: key });
    if (found) activated.add(key);
    return Boolean(found);
  } catch (err) {
    console.error('activation lookup failed:', err.message);
    return false;
  }
}

/**
 * Memory first, so the lead is answered even if the save fails.
 * @returns {Promise<boolean>} true when this contact was not a lead before.
 */
export async function activate(waId, { name = null, text = '' } = {}) {
  const key = conversationKey(waId);
  if (!key) return false;
  const fresh = !activated.has(key);
  activated.add(key);
  try {
    const res = await (await collection('activations')).updateOne(
      { waId: key },
      { $setOnInsert: { waId: key, name, text, createdAt: new Date() } },
      { upsert: true }
    );
    return res.upsertedCount > 0;
  } catch (err) {
    console.error('activation save failed:', err.message);
    return fresh;
  }
}

/** Terminal chat only: forget the lead so the trigger phrase starts over. */
export async function deactivate(waId) {
  const key = conversationKey(waId);
  activated.delete(key);
  try {
    await (await collection('activations')).deleteOne({ waId: key });
  } catch (err) {
    console.error('activation reset failed:', err.message);
  }
}

/** Tests only. */
export function _resetActivationCache() {
  activated.clear();
}
