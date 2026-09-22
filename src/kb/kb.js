// The knowledge base: every .md / .txt / .json file in knowledge/, chunked, embedded with
// OpenAI and searched by cosine similarity. Ported from wati_chat-bot/src/kb.js without the
// keyword-trigger filtering this bot does not use.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { config } from '../config.js';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json']);
let openai;
let store = null; // { hash, mode, model, chunks: [{ id, text, source, section, embedding? }] }

const client = () =>
  (openai ??= new OpenAI({
    apiKey: config.openai.apiKey,
    ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
    timeout: 20_000,
    maxRetries: 1,
  }));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/* ------------------------------- loading ------------------------------- */

function readKnowledgeFiles() {
  const dir = config.kb.dir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function chunkMarkdown(rawContent, source) {
  const { chunkSize, chunkOverlap } = config.kb;
  // HTML comments are authoring notes, not knowledge — keep them out of the index.
  const content = rawContent.replace(/<!--[\s\S]*?-->/g, '');
  const chunks = [];
  const headings = [];
  let buffer = '';
  let section = '';

  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    if (text.length <= chunkSize) {
      chunks.push({ text, source, section });
      return;
    }
    for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
      const slice = text.slice(i, i + chunkSize).trim();
      if (slice) chunks.push({ text: slice, source, section });
    }
  };

  for (const line of content.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = heading[2].trim();
      section = headings.filter(Boolean).join(' > ');
      buffer += `${section}\n`;
      continue;
    }
    buffer += `${line}\n`;
    if (buffer.length >= chunkSize) flush();
  }
  flush();
  return chunks;
}

/** A JSON file may be a list of { question, answer } (or { q, a }) FAQ rows. */
function chunkJson(content, source) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return [{ text: content.slice(0, config.kb.chunkSize), source, section: '' }];
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data.faqs) ? data.faqs : [data];
  return rows.map((row, i) => {
    const q = row.question ?? row.q ?? row.title ?? '';
    const a = row.answer ?? row.a ?? row.content ?? '';
    const text = q || a ? `Q: ${q}\nA: ${a}` : JSON.stringify(row);
    return { text, source, section: row.category || row.section || q || `item ${i + 1}` };
  });
}

export function buildChunks() {
  const chunks = [];
  for (const file of readKnowledgeFiles()) {
    const ext = path.extname(file.name).toLowerCase();
    chunks.push(...(ext === '.json' ? chunkJson(file.content, file.name) : chunkMarkdown(file.content, file.name)));
  }
  return chunks.map((c, i) => ({ id: `c${i}`, ...c }));
}

/* ------------------------------ embedding ------------------------------ */

async function embedBatch(texts) {
  const out = [];
  const BATCH = 96;
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await client().embeddings.create({ model: config.openai.embeddingModel, input: texts.slice(i, i + BATCH) });
    out.push(...res.data.map((d) => d.embedding));
  }
  return out;
}

const corpusHash = (chunks) => sha1(`${config.openai.embeddingModel}::${chunks.map((c) => c.text).join(' ')}`);
const embeddingsAvailable = () => !!config.openai.apiKey && config.kb.searchMode !== 'lexical';

/** Builds (or reuses) the index. Set force to ignore the on-disk cache. */
export async function ensureIndex({ force = false, log = () => {} } = {}) {
  const chunks = buildChunks();
  if (!chunks.length) {
    store = { hash: 'empty', mode: 'none', model: null, chunks: [] };
    log('No knowledge files found in knowledge/ — every question will be handed to the team.');
    return store;
  }

  const hash = corpusHash(chunks);
  if (!embeddingsAvailable()) {
    store = { hash, mode: 'lexical', model: null, chunks };
    log(`Knowledge base ready: ${chunks.length} chunks, keyword search.`);
    return store;
  }
  if (!force && store?.hash === hash && store.mode === 'embedding') return store;

  if (!force && fs.existsSync(config.kb.cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(config.kb.cacheFile, 'utf8'));
      if (cached.hash === hash) {
        store = cached;
        log(`Loaded ${cached.chunks.length} cached knowledge chunks.`);
        return store;
      }
    } catch {
      /* corrupt cache — rebuild below */
    }
  }

  log(`Embedding ${chunks.length} knowledge chunks with ${config.openai.embeddingModel}...`);
  let embeddings;
  try {
    embeddings = await embedBatch(chunks.map((c) => `${c.section}\n${c.text}`));
  } catch (err) {
    if (config.kb.searchMode !== 'auto') throw err;
    store = { hash, mode: 'lexical', model: null, chunks };
    log(`Embeddings failed (${err.message}); using keyword search over the knowledge files.`);
    return store;
  }
  store = {
    hash,
    mode: 'embedding',
    model: config.openai.embeddingModel,
    chunks: chunks.map((c, i) => ({ ...c, embedding: embeddings[i] })),
  };
  fs.mkdirSync(path.dirname(config.kb.cacheFile), { recursive: true });
  fs.writeFileSync(config.kb.cacheFile, JSON.stringify(store));
  log(`Knowledge base indexed: ${store.chunks.length} chunks.`);
  return store;
}

/* ------------------------------ retrieval ------------------------------ */

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Chat messages are full of filler; a filler word that is rare in the corpus would otherwise
// decide a keyword ranking on its own.
const STOP_WORDS = new Set(
  `a an and are as at be by can do does for from have how i in is it me my of on or our so
   that the to want we what when where which who why you your please tell give
   also already always any anything been before being but could did doing dont even ever
   every get getting going got had has having here him his into its just let like make may
   might more most must no not now off only other out over own said same see shall she
   should since some still such take than their them then there these they thing things
   this those through under until upon use very was way well were will with would yes
   hai hain kar karo mujhe mera meri mere aur bhi sir mam madam maam bhai bro yaar plz pls`
    .split(/\s+/)
    .filter(Boolean)
);

const terms = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

/** Share of the question's rare terms a chunk covers (0-1), comparable to KB_MIN_SCORE. */
function lexicalScores(question, candidates) {
  const queryTerms = [...new Set(terms(question))];
  if (!queryTerms.length) return candidates.map((c) => ({ ...c, score: 0 }));
  const docs = candidates.map((c) => new Set(terms(`${c.section} ${c.text}`)));
  const idf = new Map(
    queryTerms.map((t) => {
      const hits = docs.reduce((n, d) => n + (d.has(t) ? 1 : 0), 0);
      return [t, Math.log(1 + candidates.length / (1 + hits))];
    })
  );
  const total = queryTerms.reduce((sum, t) => sum + idf.get(t), 0) || 1;
  return candidates.map((c, i) => ({
    ...c,
    score: queryTerms.reduce((sum, t) => sum + (docs[i].has(t) ? idf.get(t) : 0), 0) / total,
  }));
}

/** The top-k chunks scoring at or above KB_MIN_SCORE, best first. Empty = nothing relevant. */
export async function search(question, { topK = config.kb.topK, minScore = config.kb.minScore } = {}) {
  const index = await ensureIndex();
  if (!index.chunks.length) return [];

  let scored;
  if (index.mode === 'lexical') {
    scored = lexicalScores(question, index.chunks);
  } else {
    try {
      const [queryEmbedding] = await embedBatch([question]);
      scored = index.chunks.map((c) => ({ ...c, score: cosine(queryEmbedding, c.embedding) }));
    } catch (err) {
      if (config.kb.searchMode !== 'auto') throw err;
      scored = lexicalScores(question, index.chunks);
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .filter((c) => c.score >= minScore)
    .slice(0, topK)
    .map(({ embedding, ...rest }) => rest);
}

export function indexStats() {
  return {
    chunks: store?.chunks.length ?? 0,
    mode: store?.mode ?? null,
    model: store?.model ?? null,
    hash: store?.hash ?? null,
  };
}
