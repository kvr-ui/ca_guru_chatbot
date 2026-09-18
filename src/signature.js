import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * `X-Wacrm-Signature: t=<unix_seconds>,v1=<hex>` where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`).
 * Must run on the RAW body, before JSON parsing can reorder or reformat it.
 * Same check as drip_engine/src/services/webhooks.js verifySignature().
 */
export function verifySignature(
  rawBody,
  header,
  { secret = config.wacrm.webhookSecret, toleranceMs = config.wacrm.webhookToleranceMs, now = Date.now() } = {}
) {
  if (!secret) return { ok: false, reason: 'WACRM_WEBHOOK_SECRET is not set' };
  if (!header) return { ok: false, reason: 'missing X-Wacrm-Signature header' };

  const match = /t=(\d+),\s*v1=([0-9a-f]+)/i.exec(String(header));
  if (!match) return { ok: false, reason: 'malformed signature header' };
  const [, t, v1] = match;

  // Replay guard: a valid signature stays valid forever without it.
  const ageMs = Math.abs(now - Number(t) * 1000);
  if (ageMs > toleranceMs) return { ok: false, reason: `signature timestamp is ${Math.round(ageMs / 1000)}s old` };

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(v1).toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature does not match' };
  return { ok: true };
}

/** Builds a header the way wacrm does — used by the tests. */
export function sign(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
