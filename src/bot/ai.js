import { config } from '../config.js';
import { search } from '../kb/kb.js';
import * as openai from '../providers/openai.js';

/** The model says this, and only this, when the knowledge base does not answer the question. */
export const HANDOVER_TOKEN = 'HANDOVER';

const SYSTEM_PROMPT = `You are ${config.bot.name}, the WhatsApp assistant for students using the CA Guru app by FOCASEdu.

Rules:
- Answer ONLY from the KNOWLEDGE BASE below. Never answer from your own knowledge, and never invent a price, date, link, phone number, email, policy or feature.
- Any question about a price, fee, cost, discount, offer or amount: reply with exactly ${HANDOVER_TOKEN} and nothing else. Never state or guess an amount. Our team handles every price question.
- Answer every other question the KNOWLEDGE BASE covers. If it does not clearly answer the question, reply with exactly ${HANDOVER_TOKEN} and nothing else. Never add advice, tips or facts of your own, even to be helpful. If the student asks what to do, how to prepare or study, or for a plan, and no entry gives that exact advice, reply ${HANDOVER_TOKEN} — a related entry (dates, subjects) is not an answer to it.
- When an entry has a "Send:" line, send that text, adjusted only to the student's wording. Lines starting "Asked as:" are search hints: never repeat them. Follow any instruction in an entry, never send it.
- Speak as the team: "we", "us", "our team".
- Reply ONLY in English, always. Students may write in Tamil, Thanglish or any other language: understand it, but never reply with a single word of Tamil, Thanglish, Hindi or any language other than English.
- Keep replies short and WhatsApp friendly: under 120 words, plain sentences, no headings or tables. Use *single asterisks* for bold and "- " for lists. Never use ** or #.
- Never mention the knowledge base, documents, context, or that you are an AI model.`;

function buildContext(chunks) {
  return ['KNOWLEDGE BASE:', ...chunks.map((c, i) => `[${i + 1}] ${c.section ? `${c.section}\n` : ''}${c.text}`)].join('\n\n');
}

/**
 * Answers a question from the knowledge base.
 * history: [{ role: 'user'|'assistant', content }]
 * profile: one line about the student from the qualifying questions, or ''.
 * @returns {{ handover: boolean, text?: string, reason: string, sources: object[], model?: string }}
 */
export async function answer(question, { history = [], profile = '' } = {}) {
  // Short follow-ups such as "and on iPhone?" need the previous question's topic to retrieve anything.
  const previousQuestion = history.filter((m) => m.role === 'user').at(-1)?.content;
  const refersBack = /^(and\b|also\b|what about\b|how about\b)|\b(it|that|those|they|them|this)\b/i.test(question);
  const followup = previousQuestion && refersBack && question.trim().split(/\s+/).length <= 8;
  const chunks = await search(followup ? `${previousQuestion}\n${question}` : question);

  const sources = chunks.map((c) => ({ source: c.source, section: c.section, score: Number(c.score.toFixed(3)) }));

  // Nothing relevant: don't even ask the model, it would only be tempted to improvise.
  if (!chunks.length) return { handover: true, reason: 'no_kb_match', sources };

  const res = await openai.complete({
    system: [
      SYSTEM_PROMPT,
      ...(profile ? [`ABOUT THIS STUDENT (their own answers; use only to tailor the reply, never as a source of facts): ${profile}`] : []),
      buildContext(chunks),
    ],
    history,
    question,
  });

  // Any reply carrying the token is a refusal, however the model dressed it up.
  if (res.text.includes(HANDOVER_TOKEN)) {
    return { handover: true, reason: 'model_handover', sources, model: res.model };
  }
  return { handover: false, text: res.text, reason: 'answered', sources, model: res.model };
}
