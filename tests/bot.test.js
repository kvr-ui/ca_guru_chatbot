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
let rateLimitNext = false;
let wamidSeq = 0;

let app, handleEvent, sign, verifySignature, isPaused, getDb, closeMongo;
let resetHandover, resetOptOut, resetHandler, resetOutbox, answer;

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
        res.end(JSON.stringify({ choices: [{ message: { content: modelReply } }], model: 'gpt-test', usage: {} }));
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
    STAFF_CONFIRM_MS: '30',
    BOT_MAX_MESSAGES_PER_HOUR: '30',
    ADMIN_TOKEN: 'admin-test',
  });

  ({ app } = await import('../src/app.js'));
  ({ handleEvent } = await import('../src/webhook.js'));
  ({ sign, verifySignature } = await import('../src/signature.js'));
  ({ isPaused, _resetHandoverCache: resetHandover } = await import('../src/handover.js'));
  ({ _resetOptOutCache: resetOptOut } = await import('../src/optout.js'));
  ({ _resetHandlerState: resetHandler } = await import('../src/handler.js'));
  ({ _resetOutbox: resetOutbox } = await import('../src/outbox.js'));
  ({ answer } = await import('../src/ai.js'));
  ({ getDb, closeMongo } = await import('../src/mongo.js'));

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
  rateLimitNext = false;
  const db = await getDb();
  await Promise.all(['messages', 'handovers', 'optouts', 'sent'].map((c) => db.collection(c).deleteMany({})));
  resetHandover();
  resetOptOut();
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
