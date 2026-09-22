// wacrm — the FOCAS WhatsApp API. Ported from drip_engine/src/providers/wacrm.js, trimmed to
// what a reply bot needs: plain text inside the 24-hour window the student just opened.
//
// Docs: Focas-Production/Focas-WA/docs/API-DOCS.md — POST /api/v1/messages, bearer key,
// E.164 numbers, { data } / { error } envelopes, 120 requests/minute per key.

import { config } from '../config.js';

// Retrying these changes nothing — the key, the scopes or the payload have to change first.
const PERMANENT_CODES = new Set(['unauthorized', 'forbidden', 'bad_request', 'not_found']);
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);

/** WhatsApp's text limit is 4096; stay clear of it rather than have Meta reject the reply. */
export const MAX_TEXT = 4000;

const ready = () => Boolean(config.wacrm.baseUrl && config.wacrm.apiKey);

export const toE164 = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `+${digits}` : null;
};

async function call(path, { method = 'POST', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.wacrm.timeoutMs);
  try {
    const res = await fetch(`${config.wacrm.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.wacrm.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    return { res, parsed };
  } finally {
    clearTimeout(timer);
  }
}

function failure(res, parsed) {
  const code = parsed?.error?.code || null;
  const detail = parsed?.error?.message || parsed?.raw || `HTTP ${res.status}`;

  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'));
    return {
      ok: false,
      error: `rate limited by wacrm — ${detail}`,
      code: 'rate_limited',
      status: 429,
      retryAfterMs: res.headers.has('retry-after') && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000,
    };
  }
  if (res.status === 402) {
    return { ok: false, error: `wacrm wallet: ${detail}`, code: 'insufficient_balance', status: 402 };
  }
  return {
    ok: false,
    error: `${code || 'error'} (${res.status}): ${detail}`,
    code,
    status: res.status,
    permanent: PERMANENT_CODES.has(code) || PERMANENT_STATUSES.has(res.status),
  };
}

/** Verifies the key against /api/v1/me — needs no scopes, so it is a clean credentials check. */
export async function check() {
  if (!ready()) return { ok: false, error: 'WACRM_BASE_URL / WACRM_API_KEY are not set' };
  try {
    const { res, parsed } = await call('/api/v1/me', { method: 'GET' });
    if (!res.ok) return failure(res, parsed);
    return { ok: true, account: parsed?.data ?? parsed };
  } catch (err) {
    return { ok: false, error: `could not reach wacrm: ${err.name === 'AbortError' ? 'timed out' : err.message}` };
  }
}

/** Sends one text message. Returns { ok, id } or { ok: false, error, permanent?, retryAfterMs? }. */
export async function sendText(to, text) {
  if (!ready()) return { ok: false, error: 'wacrm is not configured — set WACRM_BASE_URL and WACRM_API_KEY', permanent: true };
  const e164 = toE164(to);
  if (!e164) return { ok: false, error: `"${to}" is not a usable phone number`, permanent: true };
  const body = String(text ?? '').trim().slice(0, MAX_TEXT);
  if (!body) return { ok: false, error: 'message text is empty', permanent: true };

  try {
    const { res, parsed } = await call('/api/v1/messages', { body: { to: e164, type: 'text', text: body } });
    if (!res.ok) return failure(res, parsed);
    // The docs guarantee the { data } envelope but not which id field a send returns.
    const data = parsed?.data ?? parsed ?? {};
    const id = data.whatsapp_message_id || data.message_id || data.id || null;
    return { ok: true, id, status: res.status };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${config.wacrm.timeoutMs}ms` : err.message;
    return { ok: false, error: `wacrm request failed: ${reason}` };
  }
}
