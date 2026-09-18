import { config } from '../src/config.js';
import { buildChunks } from '../src/kb.js';

/**
 * Sanity-checks knowledge/ after an edit:  npm run check:kb
 * Flags files that split into several chunks (the second half loses its heading), files with
 * no heading, and leftover TODO / XXX markers that would be sent to a student verbatim.
 */
const chunks = buildChunks();
const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.source)) byFile.set(c.source, []);
  byFile.get(c.source).push(c);
}

let problems = 0;
console.log(`knowledge/  ${byFile.size} files, ${chunks.length} chunks\n`);
for (const [file, list] of [...byFile].sort()) {
  const chars = list.reduce((n, c) => n + c.text.length, 0);
  const notes = [];
  if (list.length > 1 && !file.endsWith('.json')) notes.push(`SPLIT into ${list.length} chunks — split the topic into smaller files`);
  if (!list[0].section) notes.push('no # heading — the topic has no name to be found by');
  if (list.some((c) => /\b(TODO|TBD|XXX)\b/.test(c.text))) notes.push('contains TODO/TBD/XXX — the bot would send it');
  problems += notes.length;
  console.log(`  ${String(chars).padStart(5)}  ${file}${notes.map((n) => `\n        ! ${n}`).join('')}`);
}
if (!chunks.length) {
  console.log('  (empty) add .md files — see docs/knowledge-base-guide.md');
  problems++;
}
console.log(problems ? `\n${problems} problem(s) to fix.` : `\nAll good. Chunk limit ${config.kb.chunkSize} chars.`);
process.exit(problems ? 1 : 0);
