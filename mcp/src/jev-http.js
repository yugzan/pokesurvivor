// POST /agent/jev: Jev for the game page itself ("Jev plays" in Settings > AI),
// without any MCP agent or pairing. TypeSafe's API does not allow the game's
// origin (CORS), so the page asks here and this forwards the call.
//   Header X-Jev-Key: the player's own key (kept only in their browser).
//   Body {kind:'choice', state, choice, withReroll} | {kind:'strategy', state} | {kind:'tactic', state}
//        ('tactic': state.tactics.candidates, the page's tactic candidates; Jev picks one)
//        state / choice: the same objects the page reports on /agent/report.
//   200 -> the same result as evaluate_choices / suggest_strategy (no overlay); for 'strategy'
//          with 2+ switchable move slots it also has slot, slot_probabilities, slot_confidence.
//   Error -> {error, kind}; 401 missing_key/auth, 429 rate, 400 bad_request, 502 others.
// The key goes only to TypeSafe: it is never logged, stored or sent back.
// So that this cannot be used as an open proxy to TypeSafe, state and choice are
// reduced to the fields the questions use (bounded strings, numbers, list sizes),
// the key must look like a key, and there is a per-IP and a global rate limit.
import { readBody, BodyTooLarge, sendJson } from './http-util.js';
import { systemOne, JevError } from './jev-client.js';
import {
  summarizeState, buildChoiceQuestions, strategyQuestions, parseChoiceAnswer, parseStrategyAnswer, cardsOf, canReroll,
  tacticQuestions, parseTacticAnswer, tacticsOf, TACTIC_ID_RE,
} from './jev-core.js';

const STATUS = { missing_key: 401, auth: 401, rate: 429, bad_request: 400 };
const PAGE_MISSING_KEY = 'Jev key missing: set it in Settings > AI';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const KEY_RE = /^[\x21-\x7E]{1,1024}$/;       // visible ASCII only
const CHOICE_KINDS = ['levelup', 'item', 'bond'];
export const LIMITS = { cards: 12, text: 200, name: 60, moves: 12, enemies: 40, pickups: 30, stats: 20, slots: 6, slotMoves: 4, types: 3, tactics: 6, numbers: 16 };

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

/** Only what summarizeState reads, bounded. */
export function sanitizeState(s) {
  const p = isObj(s.player) ? s.player : {};
  const stats = {};
  if (isObj(p.stats)) {
    for (const [k, v] of Object.entries(p.stats)) {
      if (Object.keys(stats).length >= LIMITS.stats) break;
      if (k.length <= 24 && num(v) !== undefined) stats[k] = v;
    }
  }
  return {
    phase: str(s.phase, 20) ?? null,
    time: num(s.time),
    player: {
      hp: num(p.hp), maxHp: num(p.maxHp), level: num(p.level),
      moves: list(p.moves, LIMITS.moves).filter(isObj).map((m) => ({
        id: str(m.id, LIMITS.name), name: str(m.name, LIMITS.name), lv: num(m.lv), maxLv: num(m.maxLv),
        ...(m.evolved === true ? { evolved: true } : {}),
        ...(isObj(m.evo) && typeof m.evo.into === 'string' ? { evo: { into: str(m.evo.into, LIMITS.name), needs: str(m.evo.needs, LIMITS.name), ready: m.evo.ready === true } } : {}),
      })),
      item: str(p.item, LIMITS.name) ?? null,
      stats,
      active: Number.isInteger(p.active) ? p.active : undefined,
      locked: !!p.locked,
      slots: list(p.slots, LIMITS.slots).filter((g) => isObj(g) && Number.isInteger(g.index) && g.index >= 0 && g.index < LIMITS.slots)
        .map((g) => ({
          index: g.index,
          moves: list(g.moves, LIMITS.slotMoves).filter(isObj).map((m) => ({
            id: str(m.id, LIMITS.name), name: str(m.name, LIMITS.name), lv: num(m.lv),
            type: str(m.type, 20), kind: str(m.kind, 20), range: num(m.range), radius: num(m.radius), cd: num(m.cd),
          })),
        })),
    },
    enemies: list(s.enemies, LIMITS.enemies).filter(isObj).map((e) => ({
      dx: num(e.dx), dy: num(e.dy), dist: num(e.dist), hp: num(e.hp), maxHp: num(e.maxHp), boss: !!e.boss, name: str(e.name, LIMITS.name),
      types: list(e.types, LIMITS.types).map((t) => str(t, 20)).filter(Boolean),
    })),
    pickups: list(s.pickups, LIMITS.pickups).map(() => ({})),          // only the count is used
    autopilot: isObj(s.autopilot) ? { mode: str(s.autopilot.mode, 20) ?? null } : null,
    ...(isObj(s.tactics) ? { tactics: sanitizeTactics(s.tactics) } : {}),
  };
}

/** Tactic candidates: id, short label and up to 16 numbers (number, boolean or short text) each. */
export function sanitizeTactics(t) {
  const candidates = list(t.candidates, LIMITS.tactics).filter((c) => isObj(c) && typeof c.id === 'string' && TACTIC_ID_RE.test(c.id))
    .map((c) => {
      const numbers = {};
      if (isObj(c.numbers)) {
        for (const [k, v] of Object.entries(c.numbers)) {
          if (Object.keys(numbers).length >= LIMITS.numbers) break;
          if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
          if (num(v) !== undefined || typeof v === 'boolean') numbers[k] = v;
          else if (typeof v === 'string') numbers[k] = v.slice(0, 80);
        }
      }
      return { id: c.id, label: str(c.label, LIMITS.text) ?? c.id, numbers };
    });
  const plan = typeof t.plan === 'string' && TACTIC_ID_RE.test(t.plan) ? t.plan : undefined;
  return { candidates, ...(plan ? { plan } : {}) };
}

/** Choice with at most 12 cards and short texts; null if the kind is unknown. */
export function sanitizeChoice(c) {
  if (!CHOICE_KINDS.includes(c.kind)) return null;
  const cards = (Array.isArray(c.cards) ? c.cards : []).filter((x) => isObj(x) && Number.isInteger(x.index) && x.index >= 0 && x.index < 100)
    .slice(0, LIMITS.cards)
    .map((x) => {
      const out = { index: x.index };
      for (const f of ['key', 'type', 'title', 'desc', 'tag']) { const v = str(x[f], LIMITS.text); if (v !== undefined) out[f] = v; }
      return out;
    });
  const out = { cid: Number.isInteger(c.cid) ? c.cid : 0, kind: c.kind, rerolls: Number.isInteger(c.rerolls) ? Math.max(0, Math.min(99, c.rerolls)) : 0, cards };
  if (c.mode !== undefined) out.mode = str(c.mode, 20);
  if (Number.isInteger(c.step)) out.step = Math.max(0, Math.min(9, c.step));
  return out;
}
const err = (res, status, kind, error, headers) => sendJson(res, status, { error, kind }, headers);

export async function handleJev(req, res, { config, limiter, globalLimiter, ip }) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed', kind: 'bad_request' }, { Allow: 'POST' });
  if (!limiter.take(ip) || (globalLimiter && !globalLimiter.take('all'))) {
    req.resume();
    return err(res, 429, 'rate', 'too many requests', { 'Retry-After': '1' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, config.pageBodyMax));
  } catch (e) {
    if (e instanceof BodyTooLarge) return err(res, 413, 'bad_request', 'body too large');
    return err(res, 400, 'bad_request', 'invalid JSON');
  }
  const h = req.headers['x-jev-key'];
  const key = typeof h === 'string' ? h.trim() : '';
  if (!key) return err(res, 401, 'missing_key', PAGE_MISSING_KEY);
  if (!KEY_RE.test(key)) return err(res, 400, 'bad_request', 'invalid Jev key format');
  if (!isObj(body) || !isObj(body.state)) return err(res, 400, 'bad_request', 'state must be an object');
  const clean = sanitizeState(body.state);

  let questions, parse, state;
  if (body.kind === 'choice') {
    const choice = isObj(body.choice) ? sanitizeChoice(body.choice) : null;
    if (!choice || !cardsOf(choice).length) return err(res, 400, 'bad_request', 'choice must have a known kind and cards');
    const withReroll = !!body.withReroll && canReroll(choice);
    state = summarizeState(clean, choice);
    questions = buildChoiceQuestions(choice, withReroll);
    parse = (r) => parseChoiceAnswer(r, choice, withReroll);
  } else if (body.kind === 'strategy') {
    state = summarizeState(clean, null);
    questions = strategyQuestions(clean);
    parse = parseStrategyAnswer;
  } else if (body.kind === 'tactic') {
    if (tacticsOf(clean).length < 2) return err(res, 400, 'bad_request', 'state.tactics.candidates must have at least 2 tactics');
    state = summarizeState(clean, null);
    questions = tacticQuestions(clean);
    parse = (r) => parseTacticAnswer(r, clean);
  } else {
    return err(res, 400, 'bad_request', "kind must be 'choice', 'strategy' or 'tactic'");
  }

  try {
    const r = await systemOne({ key, state, questions, config });
    return sendJson(res, 200, parse(r));
  } catch (e) {
    if (!(e instanceof JevError)) throw e;
    const status = STATUS[e.kind] || 502;
    const message = e.kind === 'missing_key' ? PAGE_MISSING_KEY : e.message;
    return err(res, status, e.kind, message, status === 429 ? { 'Retry-After': '1' } : undefined);
  }
}
