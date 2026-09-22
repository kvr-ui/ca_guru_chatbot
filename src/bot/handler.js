import { config, conversationKey } from '../config.js';
import { answer } from './ai.js';
import { logTurn, lastTurns } from '../store/conversations.js';
import { isOptedOut, isOptOutRequest, isOptInRequest, optOut, optIn } from './optout.js';
import { pauseForHandover, isPaused } from './handover.js';

/**
 * The bot's brain. Transport-agnostic: the wacrm webhook and the terminal chat (npm run chat)
 * go through exactly this path. Returns the replies to send; it never sends anything itself.
 *
 * Every exchange is logged once, whichever branch answered it — a failed one included.
 * @returns {Promise<{ replies: string[], meta: object }>}
 */
export async function handleMessage(event) {
  const started = Date.now();
  const waId = conversationKey(event.waId);
  let result;
  try {
    result = await route({ ...event, waId });
  } catch (err) {
    result = { replies: [], meta: { reason: 'error', error: err.message } };
    await logTurn({ waId, name: event.name, text: event.text, meta: result.meta });
    throw err;
  }
  await logTurn({
    waId,
    name: event.name,
    text: event.text,
    replies: result.replies,
    meta: { ...result.meta, type: event.type },
    elapsedMs: Date.now() - started,
  });
  return result;
}

/** Media a person sends on purpose. Stickers, reactions and system notices get no reply. */
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'location', 'contacts', 'contact']);
/** Five photos in a row get one notice, not five. */
const MEDIA_NOTICE_EVERY_MS = 10 * 60_000;
const mediaNoticeAt = new Map();

const GREETING = /^(hi+|hello+|hey+|hlo|helo|hai|good\s+(morning|afternoon|evening)|namaste|namaskar|vanakkam)(\s+(there|sir|mam|madam|team|guru|ca guru))?[\s!.🙏👋]*$/i;
const THANKS = /^(thanks?( you)?( so much)?|thank u|thx|tq|ty)[\s!.🙏😊]*$/i;
/** Acknowledgements that need no reply at all. */
const ACK = /^(ok(ay)?|k+|fine|cool|great|got it|sure|done|alright|👍|🙏|👌)[\s!.]*$/i;

/** Answered messages per contact in the last hour; a ceiling on one person's OpenAI bill. */
const recent = new Map();
function overHourlyLimit(waId) {
  if (waId.startsWith('cli:') || !config.bot.maxMessagesPerHour) return false;
  const cutoff = Date.now() - 3_600_000;
  const times = (recent.get(waId) ?? []).filter((t) => t > cutoff);
  if (times.length >= config.bot.maxMessagesPerHour) {
    recent.set(waId, times);
    return true;
  }
  times.push(Date.now());
  recent.set(waId, times);
  return false;
}

const silent = (reason, extra = {}) => ({ replies: [], meta: { reason, ...extra } });

async function route({ waId, name, text, type = 'text' }) {
  const clean = String(text ?? '').trim();

  // STOP is permanent; only START brings the bot back.
  if (await isOptedOut(waId)) {
    if (clean && isOptInRequest(clean)) {
      await optIn(waId);
      return { replies: [config.bot.optInMessage], meta: { reason: 'opted_in' } };
    }
    return silent('opted_out');
  }
  if (clean && isOptOutRequest(clean)) {
    await optOut(waId, { name, text: clean });
    return { replies: [config.bot.optOutMessage], meta: { reason: 'opt_out' } };
  }

  // A person owns this chat: stay out of it, photos and voice notes included.
  if (await isPaused(waId)) return silent('with_team');

  if (!clean) {
    if (!MEDIA_TYPES.has(String(type)) || Date.now() - (mediaNoticeAt.get(waId) ?? 0) < MEDIA_NOTICE_EVERY_MS) {
      return silent('non_text_ignored', { type });
    }
    mediaNoticeAt.set(waId, Date.now());
    return { replies: [config.bot.mediaMessage], meta: { reason: 'media_notice', type } };
  }

  if (overHourlyLimit(waId)) return silent('rate_limited');

  // Small talk never reaches the knowledge base: "hi" matches nothing there and would hand
  // every new conversation to the team.
  if (GREETING.test(clean)) return { replies: [config.bot.welcomeMessage], meta: { reason: 'greeting' } };
  if (THANKS.test(clean)) return { replies: ["You're welcome! 😊 Ask me anytime."], meta: { reason: 'thanks' } };
  if (ACK.test(clean)) return silent('ack');

  let result;
  try {
    result = await answer(clean, { history: await lastTurns(waId) });
  } catch (err) {
    // OpenAI or embeddings down: a person answers rather than the student hearing nothing.
    console.error('answer failed:', err.message);
    await pauseForHandover(waId);
    return { replies: [config.bot.handoverMessage], meta: { reason: 'error_handover', error: err.message, handover: true } };
  }

  if (result.handover) {
    await pauseForHandover(waId);
    return {
      replies: [config.bot.handoverMessage],
      meta: { reason: result.reason, sources: result.sources, model: result.model ?? null, handover: true },
    };
  }
  return { replies: [result.text], meta: { reason: 'answered', sources: result.sources, model: result.model } };
}

/** Tests only. */
export function _resetHandlerState() {
  recent.clear();
  mediaNoticeAt.clear();
}
