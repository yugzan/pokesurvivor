// Minimal client for TypeSafe System One (Jev): POST {base}/v1/systemone.
// Docs: https://docs.typesafe.ai/api.md
// The key is the user's own (BYOK). It is only put in the Authorization header
// of the request to TypeSafe: never logged, stored, or copied into an error.
import { ToolError } from './tools/result.js';

export class JevError extends ToolError {
  constructor(message, kind) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;          // 'missing_key' | 'auth' | 'rate' | 'timeout' | 'bad_request' | 'server' | 'network' | 'bad_response'
  }
}

export const MISSING_KEY =
  'Jev key missing: set the X-Jev-Key header in your MCP client config, or pass jev_key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seconds from a Retry-After header (delta-seconds or HTTP date); null if absent.
function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

// Short, key-free description of TypeSafe's error body.
async function errorDetail(res, key) {
  let text = '';
  try { text = await res.text(); } catch {}
  let detail = text;
  try {
    const j = JSON.parse(text);
    const d = j?.detail ?? j?.error ?? j;
    detail = typeof d === 'string' ? d : (d?.message || d?.error_type || JSON.stringify(d));
  } catch {}
  detail = String(detail || '').replace(/\s+/g, ' ').slice(0, 200);
  if (key && detail.includes(key)) detail = detail.split(key).join('[key]');
  return detail;
}

/**
 * Ask Jev a set of questions about one state.
 * @returns {Promise<{model:string, answers:object, usage?:object}>}
 * @throws {JevError} with an LLM-readable message (never containing the key).
 */
export async function systemOne({ key, state, questions, config, fetchImpl = fetch }) {
  if (typeof key !== 'string' || !key.trim()) throw new JevError(MISSING_KEY, 'missing_key');
  key = key.trim();
  const url = `${config.jevApiBase}/v1/systemone`;
  const body = JSON.stringify({ state, model: config.jevModel, questions });
  const cap = config.jevRetryMaxMs ?? 5000;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(config.jevTimeoutMs),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new JevError(`Jev timed out after ${config.jevTimeoutMs / 1000} s; no suggestion this time (try again, or decide yourself)`, 'timeout');
      }
      throw new JevError('Jev unreachable (network error); no suggestion this time', 'network');
    }

    if (res.ok) {
      let j;
      try { j = await res.json(); } catch { throw new JevError('Jev returned an unreadable response', 'bad_response'); }
      if (!j || typeof j.answers !== 'object') throw new JevError('Jev returned an unexpected response (no answers)', 'bad_response');
      return j;
    }

    const status = res.status;
    if (status === 401 || status === 403) {
      try { await res.body?.cancel(); } catch {}
      throw new JevError(`Jev key rejected (HTTP ${status}): check the key at https://console.typesafe.ai/keys`, 'auth');
    }
    if (status === 429 || status === 529) {
      const wait = retryAfterMs(res);
      try { await res.body?.cancel(); } catch {}
      const waitMs = Math.min(cap, wait ?? 1000);
      if (attempt === 0) { await sleep(waitMs); continue; }
      const secs = Math.max(1, Math.ceil((wait ?? 1000) / 1000));
      throw new JevError(`Jev ${status === 429 ? 'rate limited' : 'overloaded'}, retry after ${secs}s`, 'rate');
    }
    const detail = await errorDetail(res, key);
    if (status === 400 || status === 413 || status === 415 || status === 422) {
      throw new JevError(`Jev rejected the request (HTTP ${status})${detail ? `: ${detail}` : ''}`, 'bad_request');
    }
    throw new JevError(`Jev error (HTTP ${status})${detail ? `: ${detail}` : ''}; no suggestion this time`, 'server');
  }
}

// Per-MCP-session limiter: at most `perSec` calls in any 1 s window. Calls
// queue (in order) until a slot frees up.
export function makeThrottle(perSec) {
  const stamps = [];
  let chain = Promise.resolve();
  return function throttle() {
    const turn = chain.then(async () => {
      for (;;) {
        const now = Date.now();
        while (stamps.length && now - stamps[0] >= 1000) stamps.shift();
        if (stamps.length < perSec) { stamps.push(now); return; }
        await sleep(1000 - (now - stamps[0]) + 1);
      }
    });
    chain = turn.catch(() => {});
    return turn;
  };
}
