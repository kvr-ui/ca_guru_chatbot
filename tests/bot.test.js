import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// Every external service is faked: one local HTTP server plays both OpenAI and wacrm, and
// MongoDB is a throwaway database on the local server, dropped at the end.
const TEST_DB = `ca_guru_bot_test_${process.pid}`;
const SECRET = 'whsec_test';
const ALLOWED = ['919000000001', '919000000002', '919000000003', '919000000004', '919000000005',
  '919000000006', '919000000007', '919000000008', '919000000009', '919000000010', '919000000011'];

let mock;
let appServer;
let base;
let sends = [];
let completions = [];
let modelReply = 'Tap *Forgot password* on the login screen.';
// What the model says when the questionnaire asks it to read an unclear reply.
let classifyReply = 'NONE';
let rateLimitNext = false;
let wamidSeq = 0;

let app, handleEvent, sign, verifySignature, isPaused, getDb, closeMongo;
let resetHandover, resetOptOut, resetHandler, resetOutbox, resetActivation, resetQuestionnaire, answer, config;

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
};

before(async () => {
  mock = await listen(
    http.createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : null;
      res.setHeader('content-type', 'application/json');

      if (req.url.endsWith('/chat/completions')) {
        completions.push(body);
        const classifying = body.messages[0].content.startsWith('You map a WhatsApp reply');
        const content = classifying ? classifyReply : modelReply;
        res.end(JSON.stringify({ choices: [{ message: { content } }], model: 'gpt-test', usage: {} }));
        return;
      }
      if (req.url === '/api/v1/messages') {
        if (rateLimitNext) {
          rateLimitNext = false;
          res.writeHead(429, { 'retry-after': '0' });
          res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }));
          return;
        }
        sends.push(body);
        res.end(JSON.stringify({ data: { whatsapp_message_id: `wamid.test${++wamidSeq}` } }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    })
  );
  const origin = `http://127.0.0.1:${mock.address().port}`;

  Object.assign(process.env, {
    OPENAI_API_KEY: 'test-only',
    OPENAI_BASE_URL: `${origin}/v1`,
    KB_SEARCH_MODE: 'lexical',
    KB_DIR: path.join(import.meta.dirname, 'fixtures', 'knowledge'),
    KB_CACHE_FILE: path.join(os.tmpdir(), `ca-guru-bot-test-${process.pid}.json`),
    KB_MIN_SCORE: '0.3',
    MONGO_URL: 'mongodb://127.0.0.1:27017',
    MONGO_DB: TEST_DB,
    WACRM_BASE_URL: origin,
    WACRM_API_KEY: 'test-key',
    WACRM_WEBHOOK_SECRET: SECRET,
    WACRM_WEBHOOK_ALLOW_UNSIGNED: 'false',
    BOT_ALLOWLIST: ALLOWED.join(','),
    // Off by default here; the trigger test switches it on.
    BOT_TRIGGER_PHRASE: '',
    STAFF_CONFIRM_MS: '30',
    BOT_MAX_MESSAGES_PER_HOUR: '30',
    ADMIN_TOKEN: 'admin-test',
  });

  ({ app } = await import('../src/http/app.js'));
  ({ handleEvent } = await import('../src/http/webhook.js'));
  ({ sign, verifySignature } = await import('../src/http/signature.js'));
  ({ isPaused, _resetHandoverCache: resetHandover } = await import('../src/bot/handover.js'));
  ({ _resetOptOutCache: resetOptOut } = await import('../src/bot/optout.js'));
  ({ _resetActivationCache: resetActivation } = await import('../src/bot/activation.js'));
  ({ _resetQuestionnaireCache: resetQuestionnaire } = await import('../src/bot/questionnaire.js'));
  ({ config } = await import('../src/config.js'));
  ({ _resetHandlerState: resetHandler } = await import('../src/bot/handler.js'));
  ({ _resetOutbox: resetOutbox } = await import('../src/whatsapp/outbox.js'));
  ({ answer } = await import('../src/bot/ai.js'));
  ({ getDb, closeMongo } = await import('../src/store/mongo.js'));

  appServer = await listen(http.createServer(app));
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  try {
    await (await getDb()).dropDatabase();
  } catch {}
  await closeMongo?.();
  appServer.closeAllConnections();
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => mock.close(r));
});

beforeEach(async () => {
  sends = [];
  completions = [];
  modelReply = 'Tap *Forgot password* on the login screen.';
  classifyReply = 'NONE';
  rateLimitNext = false;
  const db = await getDb();
  await Promise.all(
    ['messages', 'handovers', 'optouts', 'sent', 'activations', 'profiles'].map((c) => db.collection(c).deleteMany({}))
  );
  resetHandover();
  resetOptOut();
  resetActivation();
  resetQuestionnaire();
  resetHandler();
  resetOutbox();
});

let eventSeq = 0;
const received = (waId, text, extra = {}) => ({
  id: `evt-${++eventSeq}`,
  event: 'message.received',
  data: { wa_id: waId, phone: `+${waId}`, sender_name: 'Student', content_type: 'text', text, whatsapp_message_id: `wamid.in${eventSeq}`, ...extra },
});

/* ------------------------------ signature ------------------------------ */

test('signature: valid, tampered, stale and missing', () => {
  const raw = '{"event":"message.received"}';
  assert.equal(verifySignature(raw, sign(raw, SECRET), { secret: SECRET }).ok, true);
  assert.equal(verifySignature(`${raw} `, sign(raw, SECRET), { secret: SECRET }).ok, false);
  const stale = sign(raw, SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.match(verifySignature(raw, stale, { secret: SECRET }).reason, /old/);
  assert.match(verifySignature(raw, undefined, { secret: SECRET }).reason, /missing/);
});

test('webhook route rejects unsigned events and ACKs signed ones', async () => {
  const raw = JSON.stringify({ id: 'route-1', event: 'contact.created', data: {} });
  const unsigned = await fetch(`${base}/webhooks/wacrm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  assert.equal(unsigned.status, 401);
  const signed = await fetch(`${base}/webhooks/wacrm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wacrm-signature': sign(raw, SECRET) },
    body: raw,
  });
  assert.equal(signed.status, 200);
});

/* ------------------------------- answers ------------------------------- */

test('a question the knowledge base covers is answered through wacrm', async () => {
  const out = await handleEvent(received(ALLOWED[0], 'I forgot my password, how do I reset it?'));
  assert.equal(out.reason, 'answered');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], { to: `+${ALLOWED[0]}`, type: 'text', text: modelReply });
  // The retrieved file reached the prompt.
  assert.match(completions[0].messages.map((m) => m.content).join('\n'), /Forgot password/);
});

test('a question outside the knowledge base is handed to the team, and the bot then stays quiet', async () => {
  const out = await handleEvent(received(ALLOWED[1], 'Explain the depreciation rules under AS 10'));
  assert.equal(out.reason, 'no_kb_match');
  assert.equal(completions.length, 0, 'the model is not asked when nothing matched');
  assert.match(sends[0].text, /passed it to our team/);
  assert.equal(await isPaused(ALLOWED[1]), true);

  await handleEvent(received(ALLOWED[1], 'hello?? anyone'));
  assert.equal(sends.length, 1, 'no reply while the team owns the chat');
});

test('the model answering HANDOVER hands over instead of sending the token', async () => {
  modelReply = 'HANDOVER';
  const out = await handleEvent(received(ALLOWED[2], 'I forgot my password, how do I reset it?'));
  assert.equal(out.reason, 'model_handover');
  assert.doesNotMatch(sends[0].text, /HANDOVER/);
  assert.equal(await isPaused(ALLOWED[2]), true);
});

test('greetings get the welcome without touching the model or handing over', async () => {
  await handleEvent(received(ALLOWED[3], 'Hi'));
  assert.equal(completions.length, 0);
  assert.match(sends[0].text, /CA Guru assistant/);
  assert.equal(await isPaused(ALLOWED[3]), false);
});

test('follow-ups carry the previous exchange as history', async () => {
  await handleEvent(received(ALLOWED[4], 'How do I reset my password?'));
  await handleEvent(received(ALLOWED[4], 'and on iphone?'));
  const second = completions[1].messages;
  assert.ok(second.some((m) => m.role === 'user' && /reset my password/.test(m.content)));
  assert.ok(second.some((m) => m.role === 'assistant' && m.content === modelReply));
});

/* ------------------------------- gating -------------------------------- */

test('numbers outside BOT_ALLOWLIST are logged but never answered', async () => {
  const out = await handleEvent(received('918888888888', 'How do I reset my password?'));
  assert.equal(out.skipped, 'not_allowlisted');
  assert.equal(sends.length, 0);
  const logged = await (await getDb()).collection('messages').findOne({ waId: '918888888888' });
  assert.equal(logged.reason, 'not_allowlisted');
});

test('with a trigger phrase, only leads who sent it get the bot, and they keep it', async () => {
  config.bot.triggerPhrase = 'YOUR LAST ATTEMPT';
  try {
    const other = await handleEvent(received(ALLOWED[10], 'How do I reset my password?'));
    assert.equal(other.skipped, 'not_triggered');
    assert.equal(sends.length, 0);

    // The bare phrase starts the qualifying questions, not a knowledge-base handover.
    await handleEvent(received(ALLOWED[9], 'Your last attempt!'));
    assert.match(sends[0].text, /first time\* or \*re-appearing/);
    assert.equal(completions.length, 0);

    const follow = await handleEvent(received(ALLOWED[9], 'How do I reset my password?'));
    assert.equal(follow.reason, 'answered');

    // Anywhere in the message counts; "attempt" alone does not.
    assert.equal((await handleEvent(received(ALLOWED[8], 'my attempt is may'))).skipped, 'not_triggered');
    assert.equal((await handleEvent(received(ALLOWED[8], 'Hi, tell me about YOUR LAST ATTEMPT kit'))).skipped, undefined);
  } finally {
    config.bot.triggerPhrase = '';
  }
});

test('a repeated event is handled once', async () => {
  const evt = received(ALLOWED[5], 'reset password');
  await handleEvent(evt);
  assert.equal((await handleEvent(evt)).skipped, 'duplicate');
  assert.equal(sends.length, 1);
});

test('STOP silences the contact until START', async () => {
  await handleEvent(received(ALLOWED[6], 'STOP'));
  assert.match(sends[0].text, /won't get any more/);
  await handleEvent(received(ALLOWED[6], 'reset password'));
  assert.equal(sends.length, 1);
  await handleEvent(received(ALLOWED[6], 'start'));
  assert.match(sends[1].text, /Welcome back/);
  await handleEvent(received(ALLOWED[6], 'how do I reset my password'));
  assert.equal(sends.length, 3);
});

test('"how do I stop notifications" is a question, not an opt-out', async () => {
  await handleEvent(received(ALLOWED[6], 'how do I stop notifications'));
  assert.doesNotMatch(sends[0]?.text ?? '', /won't get any more/);
});

test('a photo gets one notice, not one per photo', async () => {
  await handleEvent(received(ALLOWED[7], '', { content_type: 'image' }));
  await handleEvent(received(ALLOWED[7], '', { content_type: 'image' }));
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /type your question/);
});

/* ---------------------------- questionnaire ---------------------------- */

const asLead = async (fn) => {
  config.bot.triggerPhrase = 'YOUR LAST ATTEMPT';
  config.bot.calculatorUrl = 'https://example.test/calculator';
  try {
    await fn();
  } finally {
    config.bot.triggerPhrase = '';
    config.bot.calculatorUrl = '';
  }
};
const lastSent = () => sends.at(-1).text;
const profileOf = async (waId) => (await getDb()).collection('profiles').findOne({ waId });

test('re-appearing, one group in Sep 26: other group, confidence, then the calculator', async () => {
  await asLead(async () => {
    const lead = ALLOWED[0];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    assert.match(lastSent(), /first time/);
    await handleEvent(received(lead, '2'));
    assert.match(lastSent(), /Sep 26/);
    await handleEvent(received(lead, 'yes I wrote group 1'));
    assert.match(lastSent(), /other group/);
    await handleEvent(received(lead, 'Jan 27'));
    assert.match(lastSent(), /confident with your preparation/);
    const done = await handleEvent(received(lead, 'yes'));
    assert.equal(done.reason, 'flow_done');
    assert.match(lastSent(), /chances are in Jan 27[\s\S]*example\.test\/calculator/);
    // Every reply was read without the model.
    assert.equal(completions.length, 0);

    const profile = await profileOf(lead);
    assert.deepEqual(profile.answers, { status: 'reappearing', sep26: 'g1', otherWhen: 'jan27', confident: 'yes' });
    assert.equal(profile.step, null);
    assert.ok(profile.completedAt);
  });
});

test('re-appearing, both groups in Sep 26: asked about confidence, then the calculator', async () => {
  await asLead(async () => {
    const lead = ALLOWED[1];
    await handleEvent(received(lead, 'your last attempt'));
    await handleEvent(received(lead, 're-appearing'));
    await handleEvent(received(lead, 'g1 and g2'));
    assert.match(lastSent(), /confident about clearing/);
    await handleEvent(received(lead, 'I have some doubts'));
    assert.match(lastSent(), /calculator/);
    assert.deepEqual((await profileOf(lead)).answers, { status: 'reappearing', sep26: 'both', confident: 'no' });
  });
});

test('a {waId} in the calculator link becomes the lead\'s number, so the click can be tracked', async () => {
  await asLead(async () => {
    config.bot.calculatorUrl = 'https://example.test/calc/{waId}';
    const lead = ALLOWED[1];
    await handleEvent(received(lead, 'your last attempt'));
    await handleEvent(received(lead, 're-appearing'));
    await handleEvent(received(lead, 'g1 and g2'));
    await handleEvent(received(lead, 'no'));
    assert.match(lastSent(), new RegExp(`example\\.test/calc/${lead}$`));
  });
});

test('skipped Sep 26 joins the first-timer questions after picking the Jan 27 group', async () => {
  await asLead(async () => {
    const lead = ALLOWED[2];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    await handleEvent(received(lead, '2'));
    await handleEvent(received(lead, '4'));
    assert.match(lastSent(), /Which group\(s\).*Jan 27/);
    await handleEvent(received(lead, '3'));
    assert.match(lastSent(), /taken classes/);
    await handleEvent(received(lead, 'not yet'));
    assert.match(lastSent(), /syllabus/);
    await handleEvent(received(lead, '40%'));
    assert.match(lastSent(), /any tests/);
    await handleEvent(received(lead, 'no'));
    assert.match(lastSent(), /calculator/);
    const { answers } = await profileOf(lead);
    assert.deepEqual(answers, {
      status: 'reappearing', sep26: 'no', jan27Groups: 'both', classes: 'no', syllabus: '25to50', syllabusPercent: 40, tests: 'no',
    });
  });
});

test('unclear replies go to the model; after two misses the question is skipped', async () => {
  await asLead(async () => {
    const lead = ALLOWED[3];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    classifyReply = '2';
    await handleEvent(received(lead, 'naan rendavadhu murai ezhudhuren'));
    assert.match(lastSent(), /Sep 26/);
    classifyReply = 'NONE';
    const retry = await handleEvent(received(lead, 'hmm'));
    assert.equal(retry.reason, 'flow_retry');
    assert.match(lastSent(), /didn't catch that[\s\S]*Sep 26/);
    await handleEvent(received(lead, 'hmm again'));
    assert.match(lastSent(), /taken classes/);
    assert.equal((await profileOf(lead)).answers.sep26, 'unknown');
  });
});

test('a question mid-questionnaire is answered, then the pending question is asked again', async () => {
  await asLead(async () => {
    const lead = ALLOWED[4];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    const out = await handleEvent(received(lead, 'How do I reset my password?'));
    assert.equal(out.reason, 'answered');
    assert.equal(sends.at(-2).text, modelReply);
    assert.match(lastSent(), /Quick one before we continue[\s\S]*first time/);

    // The phrase again, or a hello, repeats the pending question instead of restarting.
    assert.equal((await handleEvent(received(lead, 'YOUR LAST ATTEMPT'))).reason, 'flow_reask');
    assert.equal((await handleEvent(received(lead, 'hi'))).reason, 'flow_reask');
    assert.match(lastSent(), /first time/);
  });
});

test('a question the team must take ends the questionnaire with the handover', async () => {
  await asLead(async () => {
    const lead = ALLOWED[5];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    await handleEvent(received(lead, 'Explain AS 10?'));
    assert.match(lastSent(), /passed it to our team/);
    assert.equal((await profileOf(lead)).endedReason, 'handover');
  });
});

test('after the questionnaire the trigger phrase gets the welcome, and the AI sees the answers', async () => {
  await asLead(async () => {
    const lead = ALLOWED[6];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    for (const reply of ['1', 'yes', '4', 'yes']) await handleEvent(received(lead, reply));
    assert.match(lastSent(), /calculator/);

    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    assert.match(lastSent(), /CA Guru assistant/);

    await handleEvent(received(lead, 'How do I reset my password?'));
    const system = completions.at(-1).messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(system, /ABOUT THIS STUDENT.*first-time CA Inter student.*over 75% of the syllabus/);
  });
});

test('a questionnaire left silent past FLOW_EXPIRY_HOURS is dropped', async () => {
  await asLead(async () => {
    const lead = ALLOWED[7];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    await (await getDb()).collection('profiles').updateOne({ waId: lead }, { $set: { updatedAt: new Date(Date.now() - 25 * 3_600_000) } });
    resetQuestionnaire();
    await handleEvent(received(lead, 'reset password'));
    assert.equal(lastSent(), modelReply);
  });
});

test('a lead from before the questionnaire keeps plain Q&A', async () => {
  await asLead(async () => {
    const lead = ALLOWED[8];
    await (await getDb()).collection('activations').insertOne({ waId: lead, createdAt: new Date() });
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT'));
    assert.match(lastSent(), /CA Guru assistant/);
    assert.equal(await profileOf(lead), null);
  });
});

test('a new lead in a chat the bot had passed to the team gets the questions at once', async () => {
  const lead = ALLOWED[4];
  await handleEvent(received(lead, 'Explain AS 10'));
  assert.equal(await isPaused(lead), true);
  await asLead(async () => {
    sends = [];
    assert.equal((await handleEvent(received(lead, 'YOUR LAST ATTEMPT'))).reason, 'flow_start');
    assert.match(lastSent(), /first time/);
    assert.equal(await isPaused(lead), false);
  });
});

test('a new lead in a chat staff are on waits, then gets the questions after the hold', async () => {
  const lead = ALLOWED[5];
  await handleEvent({
    id: 'sent-staff-lead',
    event: 'message.sent',
    data: { wa_id: lead, whatsapp_message_id: 'wamid.staff-lead', text: 'Hi, this is Priya', sender_type: 'agent' },
  });
  await asLead(async () => {
    sends = [];
    assert.equal((await handleEvent(received(lead, 'YOUR LAST ATTEMPT'))).reason, 'with_team');
    assert.equal(sends.length, 0);
    const res = await fetch(`${base}/admin/handover/${lead}/resume`, { method: 'POST', headers: { authorization: 'Bearer admin-test' } });
    assert.equal(res.status, 200);
    assert.equal((await handleEvent(received(lead, 'hi'))).reason, 'flow_start');
    assert.match(lastSent(), /first time/);
    await handleEvent(received(lead, '2'));
    assert.match(lastSent(), /Sep 26/);
  });
});

test('a hold saved before its reason was recorded counts as staff', async () => {
  const lead = ALLOWED[6];
  await (await getDb()).collection('handovers').insertOne({ waId: lead, pausedUntil: new Date(Date.now() + 3_600_000) });
  await asLead(async () => {
    assert.equal((await handleEvent(received(lead, 'YOUR LAST ATTEMPT'))).reason, 'with_team');
    assert.equal(sends.length, 0);
  });
});

test('a question sent with the trigger phrase is answered, then the questions start', async () => {
  await asLead(async () => {
    const lead = ALLOWED[9];
    await handleEvent(received(lead, 'YOUR LAST ATTEMPT how do I reset my password'));
    assert.equal(sends.at(-2).text, modelReply);
    assert.match(lastSent(), /Welcome to CA Guru[\s\S]*first time/);
  });
});

/* --------------------------- staff detection --------------------------- */

test('the bot\'s own message.sent echo is not mistaken for staff', async () => {
  await handleEvent(received(ALLOWED[8], 'reset password'));
  const out = await handleEvent({
    id: 'sent-ours',
    event: 'message.sent',
    data: { wa_id: ALLOWED[8], whatsapp_message_id: 'wamid.unknown-yet', text: modelReply, sender_type: 'agent' },
  });
  assert.equal(out.sent, 'ours');
  assert.equal(await isPaused(ALLOWED[8]), false);
});

test('a staff reply from the wacrm inbox pauses the bot for that chat', async () => {
  const out = await handleEvent({
    id: 'sent-staff',
    event: 'message.sent',
    data: { wa_id: ALLOWED[9], whatsapp_message_id: 'wamid.staff1', text: 'Hi, this is Priya from FOCAS', sender_type: 'agent' },
  });
  assert.equal(out.sent, 'staff');
  assert.equal(await isPaused(ALLOWED[9]), true);
  await handleEvent(received(ALLOWED[9], 'reset password'));
  assert.equal(sends.length, 0);
});

test('a 429 from wacrm is retried once', async () => {
  rateLimitNext = true;
  await handleEvent(received(ALLOWED[10], 'reset password'));
  assert.equal(sends.length, 1);
});

/* -------------------------------- admin -------------------------------- */

test('admin routes need the token, and resume ends a handover', async () => {
  assert.equal((await fetch(`${base}/admin/handovers`)).status, 401);
  await handleEvent(received(ALLOWED[1], 'Explain AS 10'));
  assert.equal(await isPaused(ALLOWED[1]), true);
  const res = await fetch(`${base}/admin/handover/${ALLOWED[1]}/resume`, { method: 'POST', headers: { authorization: 'Bearer admin-test' } });
  assert.equal(res.status, 200);
  assert.equal(await isPaused(ALLOWED[1]), false);
});

test('answer() never calls the model without a knowledge match', async () => {
  const out = await answer('what is the capital of France');
  assert.equal(out.handover, true);
  assert.equal(completions.length, 0);
});
