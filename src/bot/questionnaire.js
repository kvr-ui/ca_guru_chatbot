import { config, conversationKey } from '../config.js';
import { collection } from '../store/mongo.js';
import * as openai from '../providers/openai.js';

/**
 * The qualifying questions a new lead gets right after sending the trigger phrase (the
 * "CA Guru Flow" sketch). Every path ends at the Jan 27 chances calculator. Answers are kept
 * per contact in `profiles`, so the team can read them and the AI can tailor later replies.
 *
 * Replies are read cheapest first: a bare number, then keywords, then the model as a last resort.
 */

const YES = /\b(yes|yeah|yep|yup|ya|yea|haan|sure|of course|ofcourse|definitely)\b/;
const NO = /\b(no|nope|nah|not|never|didnt|dont|havent|hasnt|none)\b/;
const G1 = /\b(g ?1|gr ?1|grp ?1|group ?(1|i|one)|first group)\b/;
const G2 = /\b(g ?2|gr ?2|grp ?2|group ?(2|ii|two)|second group)\b/;
const BOTH = /\b(both|all|full|2 groups|two groups|g ?1 (and|n) g ?2)\b/;

const yesNo = (yes = YES, no = NO) => [
  { key: 'yes', label: 'Yes', match: yes },
  { key: 'no', label: 'No', match: no },
];
// "g1 and g2" also matches G1 and G2; "both" wins over them.
const groups = [
  { key: 'g1', label: 'Group 1', match: G1 },
  { key: 'g2', label: 'Group 2', match: G2 },
  { key: 'both', label: 'Both groups', match: BOTH, absorbs: ['g1', 'g2'] },
];

/** `next` returns the following step, or null for the calculator. It also gets 'unknown'. */
export const STEPS = {
  status: {
    field: 'status',
    text: 'Are you appearing for CA Inter for the *first time* or *re-appearing*?',
    options: [
      { key: 'first', label: 'First time', match: /\b(first|fresh|fresher|new|1st)\b/ },
      {
        key: 'reappearing',
        label: 'Re-appearing',
        match: /\b(re ?appear\w*|repeat\w*|again|second|2nd|third|3rd|fail\w*|re ?attempt\w*|re ?writ\w*)\b/,
      },
    ],
    next: (a) => (a === 'reappearing' ? 'sep26' : 'classes'),
  },
  sep26: {
    field: 'sep26',
    text: 'Did you write the *Sep 26* exams?',
    options: [
      { key: 'g1', label: 'Yes – Group 1 only', match: G1 },
      { key: 'g2', label: 'Yes – Group 2 only', match: G2 },
      { key: 'both', label: 'Yes – Both groups', match: BOTH, absorbs: ['g1', 'g2'] },
      { key: 'no', label: 'No', match: NO },
    ],
    next: (a) => ({ g1: 'otherWhen', g2: 'otherWhen', both: 'confidentResult', no: 'jan27Groups' })[a] ?? 'classes',
  },
  otherWhen: {
    field: 'otherWhen',
    text: 'When are you planning to write the other group?',
    options: [
      { key: 'jan27', label: 'Jan 27', match: /\b(jan\w*|27|this|coming|upcoming)\b/ },
      { key: 'later', label: 'A later attempt', match: /\b(later|may|june?|sep\w*|after|not sure|dont know|undecided)\b/ },
    ],
    next: () => 'confidentPrep',
  },
  confidentPrep: {
    field: 'confident',
    text: 'Are you confident with your preparation?',
    options: yesNo(),
    next: () => null,
  },
  confidentResult: {
    field: 'confident',
    text: 'Are you confident about clearing, or do you have doubts?',
    options: [
      { key: 'yes', label: 'Confident', match: /\b(yes|yeah|yep|sure|confident|definitely)\b/ },
      { key: 'no', label: 'I have doubts', match: /\b(no|not|doubt\w*|unsure|scared|worried|nervous|fear)\b/ },
    ],
    next: () => null,
  },
  jan27Groups: {
    field: 'jan27Groups',
    text: 'Which group(s) are you planning to write in *Jan 27*?',
    options: groups,
    next: () => 'classes',
  },
  classes: {
    field: 'classes',
    text: 'Have you taken classes yet?',
    options: yesNo(new RegExp(`${YES.source}|\\b(taken|taking|joined|enrolled|attending|going)\\b`), NO),
    next: () => 'syllabus',
  },
  syllabus: {
    field: 'syllabus',
    text: 'How much of the syllabus have you completed?',
    options: [
      { key: 'lt25', label: 'Less than 25%', max: 24 },
      { key: '25to50', label: '25–50%', max: 50 },
      { key: '50to75', label: '50–75%', max: 75 },
      { key: 'gt75', label: 'More than 75%', max: 100 },
    ],
    // "40", "40%" or "40 percent": anything above the option count is a percentage.
    percent: true,
    next: () => 'tests',
  },
  tests: {
    field: 'tests',
    text: 'Have you taken any tests to check where you stand?',
    options: yesNo(),
    next: () => null,
  },
};

const FIRST_STEP = 'status';
const DIGITS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

/** Same normalisation as activation and opt-outs, so "Didn't" and "didnt" read alike. */
const normalize = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const render = (step) =>
  `${step.text}\n\n${step.options.map((o, i) => `${DIGITS[i]} ${o.label}`).join('\n')}\n\nReply with the number.`;

export const introMessage = () =>
  `Hi! 👋 Welcome to ${config.bot.name}. A few quick questions so we can guide you better.\n\n${render(STEPS[FIRST_STEP])}`;

/**
 * A `{waId}` in CALCULATOR_URL becomes the lead's number, so each lead gets their own link. The
 * campaign dashboard's /calc/<waId> records the click (its chat shows it) and redirects on to
 * the calculator.
 */
export function calculatorMessage(waId = '') {
  const url = config.bot.calculatorUrl.replaceAll('{waId}', encodeURIComponent(waId));
  if (!url) console.warn('CALCULATOR_URL is not set — sending the calculator message without a link');
  return url ? `${config.bot.calculatorMessage}\n${url}` : config.bot.calculatorMessage;
}

/** A bare number or keywords. Returns { key, percent? } or null. */
export function matchOption(step, text) {
  const norm = normalize(text);
  const num = norm.match(/^(?:option |opt )?(\d{1,3})(?: ?(?:percent|per|pc))?$/);
  if (num) {
    const n = Number(num[1]);
    if (n >= 1 && n <= step.options.length) return { key: step.options[n - 1].key };
    if (step.percent && n <= 100) return { key: step.options.find((o) => n <= o.max).key, percent: n };
    return null;
  }
  let hits = step.options.filter((o) => o.match?.test(norm));
  const absorbed = new Set(hits.flatMap((o) => o.absorbs ?? []));
  hits = hits.filter((o) => !absorbed.has(o.key));
  return hits.length === 1 ? { key: hits[0].key } : null;
}

export const CLASSIFY_PROMPT = `You map a WhatsApp reply from a CA Inter student to one option of a multiple-choice question.
The reply may be in English, Tamil, Thanglish or Hindi.
Reply with ONLY the option number.
If the reply is a question or request of its own rather than an answer, reply QUESTION.
If it fits no option, reply NONE.`;

/** The model's reading of a reply that matched nothing. Never throws. */
async function classify(step, text) {
  try {
    const options = step.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
    const res = await openai.complete({
      system: [CLASSIFY_PROMPT],
      history: [],
      question: `Question: ${step.text}\nOptions:\n${options}\n\nStudent's reply: ${text}`,
    });
    const out = res.text.trim().toUpperCase();
    const n = Number(out.match(/^\d+/)?.[0]);
    if (n >= 1 && n <= step.options.length) return { key: step.options[n - 1].key };
    if (out.startsWith('QUESTION')) return { question: true };
  } catch (err) {
    console.error('questionnaire classify failed:', err.message);
  }
  return {};
}

/* -------------------------------- store -------------------------------- */

const profiles = new Map(); // contact key -> profile doc | null

async function load(key) {
  if (profiles.has(key)) return profiles.get(key);
  try {
    const doc = await (await collection('profiles')).findOne({ waId: key }, { projection: { _id: 0 } });
    profiles.set(key, doc ?? null);
    return doc ?? null;
  } catch (err) {
    console.error('profile lookup failed:', err.message);
    return null;
  }
}

/** Memory first, so the flow carries on even if the save fails. */
async function save(doc) {
  doc.updatedAt = new Date();
  profiles.set(doc.waId, doc);
  try {
    await (await collection('profiles')).replaceOne({ waId: doc.waId }, doc, { upsert: true });
  } catch (err) {
    console.error('profile save failed:', err.message);
  }
}

export async function getProfile(waId) {
  return load(conversationKey(waId));
}

/* -------------------------------- flow --------------------------------- */

/** Starts the questions for a new lead; returns the first message. */
export async function startFlow(waId, { name = null } = {}) {
  const key = conversationKey(waId);
  const now = new Date();
  await save({ waId: key, name, step: FIRST_STEP, answers: {}, retries: 0, startedAt: now, completedAt: null, endedReason: null });
  return introMessage();
}

/**
 * A new lead who arrived while a person held the chat: the questions wait, and start the first
 * time the student writes after the hold ends.
 */
export async function queueFlow(waId, { name = null } = {}) {
  const key = conversationKey(waId);
  const doc = await load(key);
  await save({ ...(doc ?? { waId: key, name, answers: {} }), step: null, flowQueued: true });
}

export async function isFlowQueued(waId) {
  return Boolean((await load(conversationKey(waId)))?.flowQueued);
}

/** The unfinished flow for this contact, or null. A flow left silent for FLOW_EXPIRY_HOURS is dropped. */
export async function activeFlow(waId) {
  const doc = await load(conversationKey(waId));
  if (!doc?.step) return null;
  return Date.now() - new Date(doc.updatedAt).getTime() < config.bot.flowExpiryMs ? doc : null;
}

export const pendingQuestion = (flow) => render(STEPS[flow.step]);

/** Stops an unfinished flow (the chat went to the team). Answers so far are kept. */
export async function endFlow(waId, reason) {
  const doc = await load(conversationKey(waId));
  if (!doc?.step) return;
  await save({ ...doc, step: null, endedReason: reason });
}

async function advance(flow, step, { key, percent }) {
  const answers = { ...flow.answers, [step.field]: key };
  if (percent !== undefined) answers.syllabusPercent = percent;
  const next = step.next(key);
  const doc = { ...flow, answers, retries: 0, step: next };
  if (!next) doc.completedAt = new Date();
  await save(doc);
  return next
    ? { reason: 'flow_answer', step: next, replies: [render(STEPS[next])] }
    : { reason: 'flow_done', step: null, replies: [calculatorMessage(flow.waId)] };
}

/**
 * Reads one reply to the pending question.
 * @returns {Promise<{ offScript: true } | { reason: string, step: string|null, replies: string[] }>}
 *   offScript: the student asked something of their own; answer it, then re-ask.
 */
export async function replyToFlow(flow, text) {
  const step = STEPS[flow.step];
  const matched = matchOption(step, text);
  if (matched) return advance(flow, step, matched);

  const read = await classify(step, text);
  if (read.key) return advance(flow, step, read);
  if (read.question || text.includes('?')) return { offScript: true };

  // One second chance, then move on rather than trap the student on one question.
  if (!flow.retries) {
    await save({ ...flow, retries: 1 });
    return { reason: 'flow_retry', step: flow.step, replies: [`Sorry, I didn't catch that 🙂\n\n${render(step)}`] };
  }
  return advance(flow, step, { key: 'unknown' });
}

/* ------------------------------ AI context ------------------------------ */

const SUMMARY = {
  status: { first: 'first-time CA Inter student', reappearing: 're-appearing CA Inter student' },
  sep26: {
    g1: 'wrote Group 1 in Sep 26',
    g2: 'wrote Group 2 in Sep 26',
    both: 'wrote both groups in Sep 26',
    no: 'did not write Sep 26',
  },
  otherWhen: { jan27: 'plans the other group in Jan 27', later: 'plans the other group in a later attempt' },
  confident: { yes: 'feels confident', no: 'is not confident / has doubts' },
  jan27Groups: { g1: 'plans Group 1 in Jan 27', g2: 'plans Group 2 in Jan 27', both: 'plans both groups in Jan 27' },
  classes: { yes: 'has taken classes', no: 'has not taken classes yet' },
  syllabus: {
    lt25: 'has completed under 25% of the syllabus',
    '25to50': 'has completed 25–50% of the syllabus',
    '50to75': 'has completed 50–75% of the syllabus',
    gt75: 'has completed over 75% of the syllabus',
  },
  tests: { yes: 'has taken tests', no: 'has not taken any tests' },
};

/** One line about the student for the AI prompt; '' when there is nothing to say. */
export async function profileSummary(waId) {
  const answers = (await load(conversationKey(waId)))?.answers ?? {};
  const parts = Object.entries(SUMMARY)
    .map(([field, labels]) =>
      field === 'syllabus' && answers.syllabusPercent !== undefined
        ? `has completed about ${answers.syllabusPercent}% of the syllabus`
        : labels[answers[field]]
    )
    .filter(Boolean);
  return parts.join(', ');
}

/** Tests and the terminal chat only. */
export async function resetFlow(waId) {
  const key = conversationKey(waId);
  profiles.delete(key);
  try {
    await (await collection('profiles')).deleteOne({ waId: key });
  } catch (err) {
    console.error('profile reset failed:', err.message);
  }
}

/** Tests only. */
export function _resetQuestionnaireCache() {
  profiles.clear();
}
