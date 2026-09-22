import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const str = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined ? fallback : String(v).trim();
};
const num = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v);
};
const bool = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(String(v));
};

/** WhatsApp ids are bare digits with a country code; "+91 98…" and "9198…" are one contact. */
export const contactKey = (v) => String(v ?? '').replace(/\D/g, '');

/** "cli:tester" style ids from the terminal chat keep their prefix; WhatsApp ids reduce to digits. */
export const conversationKey = (v) => {
  const raw = String(v ?? '').trim();
  return raw.startsWith('cli:') ? raw : contactKey(raw);
};

// Pasted connection strings have arrived as `MONGO_URL=MONGO_URI=mongodb+srv://…` more than
// once on these projects. Strip a leaked `NAME=` prefix instead of failing with "Invalid scheme".
const cleanMongoUrl = (v) => String(v || '').replace(/^\s*[A-Z_]+=/, '').trim();

/** "https://host/v1/chat/completions" -> "https://host/v1" (the SDK adds the path back). */
function normalizeOpenAiBase(url) {
  if (!url) return '';
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\/(chat\/)?completions$/i, '');
  return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

const allowlist = new Set(
  str('BOT_ALLOWLIST')
    .split(',')
    .map(contactKey)
    .filter(Boolean)
);

export const config = {
  root,
  port: num('PORT', 3000),
  host: str('HOST', '127.0.0.1'),
  publicBaseUrl: str('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  // Guards /admin/*. Unset = the admin routes are switched off, not open.
  adminToken: str('ADMIN_TOKEN'),

  // This bot has its OWN wacrm account and number. Never point it at the shared FOCAS
  // account: the Mentor server's MCQ bot answers every inbound there, and both would reply.
  wacrm: {
    baseUrl: str('WACRM_BASE_URL').replace(/\/+$/, ''),
    apiKey: str('WACRM_API_KEY'),
    timeoutMs: num('WACRM_TIMEOUT_MS', 15000),
    // Shown exactly once when the webhook is registered (npm run webhook:register).
    webhookSecret: str('WACRM_WEBHOOK_SECRET'),
    webhookToleranceMs: num('WACRM_WEBHOOK_TOLERANCE_MS', 5 * 60 * 1000),
    // SETUP ONLY: accept unsigned events while the secret is still unknown. Ignored as soon
    // as WACRM_WEBHOOK_SECRET is set.
    webhookAllowUnsigned: bool('WACRM_WEBHOOK_ALLOW_UNSIGNED', false),
    // Optional: append every raw webhook to this file while setting up.
    captureFile: str('WEBHOOK_CAPTURE_FILE'),
  },

  openai: {
    apiKey: str('OPENAI_API_KEY'),
    baseUrl: normalizeOpenAiBase(str('OPENAI_BASE_URL')),
    chatModel: str('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    embeddingModel: str('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  },

  kb: {
    // auto: embeddings, falling back to keyword search if they fail. lexical: keywords only.
    searchMode: str('KB_SEARCH_MODE', 'auto'),
    dir: str('KB_DIR') ? path.resolve(root, str('KB_DIR')) : path.join(root, 'knowledge'),
    cacheFile: str('KB_CACHE_FILE') ? path.resolve(root, str('KB_CACHE_FILE')) : path.join(root, 'data', 'embeddings.json'),
    topK: num('KB_TOP_K', 5),
    // Below this, nothing in the knowledge base is about the question and a person takes it.
    minScore: num('KB_MIN_SCORE', 0.3),
    chunkSize: 900,
    chunkOverlap: 150,
  },

  bot: {
    name: str('BOT_NAME', 'CA Guru'),
    // Non-empty = only these numbers are answered; everyone else is logged and ignored.
    // Clear it to go live.
    allowlist,
    // The bot only switches on for a contact once they send this phrase (the ad's prefilled
    // text); it then answers everything they send. Set it blank to answer every contact.
    triggerPhrase: str('BOT_TRIGGER_PHRASE', 'YOUR LAST ATTEMPT'),
    historyTurns: num('HISTORY_TURNS', 6),
    historyHours: num('HISTORY_HOURS', 24),
    handoverMs: num('HANDOVER_HOURS', 12) * 3_600_000,
    // Per-number ceiling on answered messages, so one contact cannot run up the OpenAI bill.
    maxMessagesPerHour: num('BOT_MAX_MESSAGES_PER_HOUR', 30),
    welcomeMessage: str(
      'WELCOME_MESSAGE',
      "Hi! 👋 I'm the CA Guru assistant. Ask me anything about the CA Guru app and I'll help right away."
    ),
    handoverMessage: str(
      'HANDOVER_MESSAGE',
      "Thanks for your question 🙏 We've passed it to our team and someone will reply to you here shortly."
    ),
    mediaMessage: str(
      'MEDIA_MESSAGE',
      "Thanks! I can't open photos, voice notes or files here, so please type your question and I'll help right away."
    ),
    optOutMessage: str(
      'OPT_OUT_MESSAGE',
      "Done — you won't get any more replies from us. Send START anytime if you'd like to chat again."
    ),
    optInMessage: str('OPT_IN_MESSAGE', "Welcome back! 👋 Ask me anything about the CA Guru app."),
    // The qualifying questions a new lead gets after the trigger phrase end with this link.
    // `{waId}` in it becomes the lead's number (see calculatorMessage).
    calculatorUrl: str('CALCULATOR_URL'),
    calculatorMessage: str(
      'CALCULATOR_MESSAGE',
      'Thanks for sharing! 🙌 Take this small assessment and see what your chances are in Jan 27 👇'
    ),
    // An unfinished questionnaire left silent this long is dropped; the bot just answers questions.
    flowExpiryMs: num('FLOW_EXPIRY_HOURS', 24) * 3_600_000,
  },

  mongo: {
    uri: cleanMongoUrl(str('MONGO_URL') || str('MONGODB_URI') || 'mongodb://127.0.0.1:27017'),
    dbName: str('MONGO_DB', 'CA-Guru-bot'),
  },
};

/** CA-Guru-Ai is the product database; this bot keeps its own state elsewhere. */
const FORBIDDEN_DBS = new Set(['ca-guru-ai']);

export function assertConfig({ requireWacrm = true } = {}) {
  const missing = [];
  if (!config.openai.apiKey) missing.push('OPENAI_API_KEY');
  if (requireWacrm && !config.wacrm.baseUrl) missing.push('WACRM_BASE_URL');
  if (requireWacrm && !config.wacrm.apiKey) missing.push('WACRM_API_KEY');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }
  if (FORBIDDEN_DBS.has(config.mongo.dbName.toLowerCase())) {
    throw new Error(`MONGO_DB is "${config.mongo.dbName}" — that is the product database. Use CA-Guru-bot.`);
  }
}
