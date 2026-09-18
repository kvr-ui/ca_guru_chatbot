#!/usr/bin/env node
//
// Registers this bot's webhook with its wacrm account.
//
//   node scripts/register-webhook.js --list        what is registered today
//   node scripts/register-webhook.js --register    register this bot
//   node scripts/register-webhook.js --disable <id>
//
// The signing secret comes back exactly once: this prints it and stops. Put it in .env as
// WACRM_WEBHOOK_SECRET and restart. Ported from drip_engine/scripts/register-webhook.js.

import { config } from '../src/config.js';

const EVENTS = [
  'message.received', // students' questions
  'message.sent', // staff replying from the wacrm inbox pauses the bot for that chat
];

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${config.wacrm.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.wacrm.apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { res, parsed };
}

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function list() {
  const { res, parsed } = await call('/api/v1/webhooks');
  if (!res.ok) die(`could not list webhooks — ${parsed?.error?.message || `HTTP ${res.status}`}`);
  const rows = parsed?.data ?? parsed ?? [];
  if (!rows.length) {
    console.log('\nNo webhooks are registered on this account.\n');
    return rows;
  }
  console.log(`\n${rows.length} webhook(s) registered:\n`);
  for (const w of rows) {
    console.log(`  ${w.is_active === false ? '○ disabled' : '● active  '}  ${w.id}`);
    console.log(`     url    ${w.url}`);
    console.log(`     events ${(w.events || []).join(', ')}\n`);
  }
  return rows;
}

async function register(force) {
  if (!config.publicBaseUrl.startsWith('https://')) {
    die(`PUBLIC_BASE_URL is "${config.publicBaseUrl || '(unset)'}". wacrm only accepts a public https:// origin.`);
  }
  const endpoint = `${config.publicBaseUrl}/webhooks/wacrm`;
  const existing = await list();

  if (existing.some((w) => w.url === endpoint && w.is_active !== false)) {
    console.log(`Already registered and active:\n  ${endpoint}\n`);
    console.log('If events are not arriving, check WACRM_WEBHOOK_SECRET. It is shown only once — if it was');
    console.log('lost, --disable the old one and register again.\n');
    return;
  }

  // Another server already listening on message.received almost always means this key belongs to
  // the shared FOCAS account, where the Mentor MCQ bot answers every message. Two bots, two replies.
  const others = existing.filter(
    (w) => w.url !== endpoint && w.is_active !== false && (w.events || []).includes('message.received')
  );
  if (others.length && !force) {
    die(
      `Another active webhook already receives message.received on this account:\n${others
        .map((w) => `    ${w.url}`)
        .join('\n')}\n\n  This looks like a shared number — whatever is behind it will reply too.\n` +
        '  Use the CA Guru bot\'s own wacrm account. Pass --force only if you are sure that server stays silent.'
    );
  }

  console.log(`Registering ${endpoint}\nEvents: ${EVENTS.join(', ')}\n`);
  const { res, parsed } = await call('/api/v1/webhooks', { method: 'POST', body: { url: endpoint, events: EVENTS } });
  if (!res.ok) {
    const message = parsed?.error?.message || `HTTP ${res.status}`;
    if (res.status === 403) die(`${message}\n\n  This key needs the webhooks:manage scope (wacrm → Settings → API keys).`);
    die(`registration failed — ${message}`);
  }

  const data = parsed?.data ?? parsed;
  const secret = data?.secret || data?.signing_secret;
  console.log('✓ Registered.\n');
  if (secret) {
    console.log('  Add this to .env now — wacrm will never show it again:\n');
    console.log(`    WACRM_WEBHOOK_SECRET=${secret}\n`);
    console.log('  Then remove WACRM_WEBHOOK_ALLOW_UNSIGNED and restart the bot.\n');
  } else {
    console.log(`  No secret in the response. Check the wacrm dashboard:\n  ${JSON.stringify(data, null, 2)}\n`);
  }
}

async function disable(id) {
  const { res, parsed } = await call(`/api/v1/webhooks/${id}`, { method: 'PATCH', body: { is_active: false } });
  if (!res.ok) die(`could not disable ${id} — ${parsed?.error?.message || `HTTP ${res.status}`}`);
  console.log(`\n✓ Disabled ${id}\n`);
}

if (!config.wacrm.baseUrl || !config.wacrm.apiKey) die('WACRM_BASE_URL and WACRM_API_KEY must be set in .env');

const [command, arg] = process.argv.slice(2);
try {
  if (command === '--list') await list();
  else if (command === '--disable') {
    if (!arg) die('usage: node scripts/register-webhook.js --disable <webhook_id>');
    await disable(arg);
  } else if (command === '--register' || !command) await register(process.argv.includes('--force'));
  else die(`unknown option "${command}" — use --list, --register [--force] or --disable <id>`);
} catch (err) {
  die(err.message);
}
