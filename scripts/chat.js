import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { assertConfig } from '../src/config.js';
import { handleMessage } from '../src/handler.js';
import { ensureIndex } from '../src/kb.js';
import { resume } from '../src/handover.js';
import { closeMongo } from '../src/mongo.js';

// Terminal chat: the same brain as WhatsApp, no wacrm needed and nothing is sent.
assertConfig({ requireWacrm: false });
await ensureIndex({ log: (m) => console.log(`[kb] ${m}`) });

const waId = `cli:${process.env.USER || 'tester'}`;
await resume(waId);
console.log('\nType a message. "/why" shows how the last reply was chosen, "/reset" ends a handover, "exit" quits.\n');

const rl = readline.createInterface({ input, output });
let lastMeta = null;
output.write('you > ');
for await (const line of rl) {
  const text = line.trim();
  if (!text) {
    output.write('you > ');
    continue;
  }
  if (['exit', 'quit'].includes(text.toLowerCase())) break;
  if (text === '/why') console.log(JSON.stringify(lastMeta, null, 2), '\n');
  else if (text === '/reset') {
    await resume(waId);
    console.log('(handover cleared)\n');
  } else {
    try {
      const { replies, meta } = await handleMessage({ waId, name: 'Tester', text });
      lastMeta = meta;
      if (!replies.length) console.log('bot > (silent)');
      for (const r of replies) console.log(`bot > ${r}`);
      console.log(`      [${meta.reason}]${meta.handover ? ' — handed to the team; /reset to continue' : ''}\n`);
    } catch (err) {
      console.error('error:', err.message, '\n');
    }
  }
  output.write('you > ');
}
rl.close();
await closeMongo();
