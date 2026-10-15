// In-memory store of game-page sessions (protocol section 1) and the command
// relay to the page (section 2). The server treats state/choice as opaque JSON
// and only reads choice.cid.
import { randomBytes, randomInt } from 'node:crypto';
import { log, short } from './log.js';
import { RateLimiter } from './http-util.js';

// A-Z without look-alikes (I, L, O) plus 2-9 (no 0/1).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export class GameError extends Error { name = 'GameError'; }

export class GameStore {
  constructor(config) {
    this.config = config;
    this.games = new Map();   // sid -> game
    this.codes = new Map();   // code -> sid (only unpaired, unexpired)
    this.reportLimiter = new RateLimiter(config.reportPerSec, 1000);
    this.cmdSeq = 0;
  }

  get size() { return this.games.size; }
  get(sid) { return typeof sid === 'string' ? this.games.get(sid) : undefined; }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.codes.has(c)) return c;
    }
  }

  create() {
    if (this.games.size >= this.config.maxGames) throw new GameError('server full');
    const now = Date.now();
    const sid = randomBytes(16).toString('hex');
    const code = this.newCode();
    const game = {
      sid, code, codeExpiresAt: now + this.config.codeTtlMs,
      owner: null, clientName: null,
      sse: null, pingTimer: null, offlineSince: now,
      state: null, choice: null, events: [],
      pending: new Map(),       // cmd id -> { resolve, timer }
      waiters: new Set(),       // { owner, afterCid, resolve, reject, timer }
    };
    this.games.set(sid, game);
    this.codes.set(code, sid);
    log('session_created', { sid: short(sid), games: this.games.size });
    return { sid, code, expiresAt: game.codeExpiresAt };
  }

  // ---- SSE to the page --------------------------------------------------
  sendEvent(game, event, data) {
    if (!game.sse) return false;
    game.sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  attachStream(game, res) {
    if (game.sse) this.detachStream(game, game.sse, true);  // one stream per sid: newest wins
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    game.sse = res;
    game.offlineSince = null;
    this.sendEvent(game, 'hello', { paired: !!game.owner });
    game.pingTimer = setInterval(() => { if (game.sse === res) res.write(': ping\n\n'); }, this.config.pingMs);
    res.on('close', () => this.detachStream(game, res, false));
    log('page_connected', { sid: short(game.sid), paired: !!game.owner });
  }

  detachStream(game, res, replaced) {
    if (game.sse !== res) return;
    clearInterval(game.pingTimer);
    game.pingTimer = null;
    game.sse = null;
    game.offlineSince = Date.now();
    if (replaced) { try { res.end(); } catch {} }
    log('page_disconnected', { sid: short(game.sid), replaced: replaced || undefined });
  }

  // ---- POST /agent/report -----------------------------------------------
  // Returns false when the per-sid rate limit is exceeded.
  report(game, body) {
    if (!this.reportLimiter.take(game.sid)) return false;
    if (body.state !== undefined) game.state = body.state;
    if (body.choice !== undefined) {
      const prev = game.choice;
      game.choice = body.choice && typeof body.choice === 'object' ? body.choice : null;
      if (game.choice && (!prev || prev.cid !== game.choice.cid)) this.wakeWaiters(game);
    }
    if (Array.isArray(body.events)) {
      for (const ev of body.events.slice(0, 20)) {
        if (!ev || typeof ev.type !== 'string') continue;
        game.events.push({ type: ev.type, data: ev.data ?? null, at: Date.now() });
        log('game_event', { sid: short(game.sid), type: ev.type.slice(0, 20) });
      }
      if (game.events.length > 20) game.events.splice(0, game.events.length - 20);
    }
    if (Array.isArray(body.results)) {
      for (const r of body.results) {
        const p = r && game.pending.get(r.id);
        if (!p) continue;
        game.pending.delete(r.id);
        clearTimeout(p.timer);
        p.resolve(r.ok === true
          ? { ok: true, data: r.data ?? {} }
          : { ok: false, error: typeof r.error === 'string' ? r.error : 'command failed' });
      }
    }
    return true;
  }

  // ---- pairing ------------------------------------------------------------
  // Consumes `code`. Returns the game or null for an unknown/expired code.
  pair(code, ownerId, clientName) {
    const sid = typeof code === 'string' ? this.codes.get(code.trim().toUpperCase()) : undefined;
    const game = sid && this.games.get(sid);
    if (!game || game.code === null || Date.now() > game.codeExpiresAt) return null;
    this.codes.delete(game.code);
    game.code = null;
    if (game.owner && game.owner !== ownerId) this.kick(game, game.owner);
    game.owner = ownerId;
    game.clientName = clientName;
    this.sendEvent(game, 'paired', { client: clientName });
    log('paired', { sid: short(game.sid), mcp: short(ownerId) });
    return game;
  }

  // Another MCP session took this game over: fail the old owner's waits.
  kick(game, oldOwner) {
    for (const w of game.waiters) {
      if (w.owner === oldOwner) w.finish(new GameError('this game was paired by another agent; ask the player for a new code and call pair(code)'));
    }
    log('pair_replaced', { sid: short(game.sid), mcp: short(oldOwner) });
  }

  unpair(game, ownerId, reason) {
    if (!game || game.owner !== ownerId) return;
    game.owner = null;
    game.clientName = null;
    for (const w of game.waiters) if (w.owner === ownerId) w.finish(null, null);
    this.sendEvent(game, 'unpaired', {});
    log('unpaired', { sid: short(game.sid), mcp: short(ownerId), reason });
  }

  // ---- commands -----------------------------------------------------------
  sendCmd(game, op, args) {
    const id = `c${(++this.cmdSeq).toString(36)}${randomBytes(3).toString('hex')}`;
    if (!this.sendEvent(game, 'cmd', { id, op, args })) {
      return Promise.resolve({ ok: false, error: 'the game page is not connected right now (tab closed or offline)' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        game.pending.delete(id);
        resolve({ ok: false, error: `the game page did not answer within ${this.config.cmdTimeoutMs / 1000} s` });
      }, this.config.cmdTimeoutMs);
      game.pending.set(id, { resolve, timer });
    });
  }

  // ---- waiting for a new choice ------------------------------------------
  // Resolves with a choice whose cid differs from/greater than `afterCid`, or null on timeout.
  waitForChoice(game, owner, afterCid, timeoutMs, signal) {
    const fresh = (c) => c && (afterCid === null || c.cid > afterCid);
    if (fresh(game.choice)) return Promise.resolve(game.choice);
    return new Promise((resolve, reject) => {
      const w = {
        owner, afterCid,
        finish: (err, value) => {
          clearTimeout(w.timer);
          signal?.removeEventListener('abort', onAbort);
          game.waiters.delete(w);
          err ? reject(err) : resolve(value);
        },
        fresh,
      };
      const onAbort = () => w.finish(null, null);
      w.timer = setTimeout(() => w.finish(null, null), timeoutMs);
      signal?.addEventListener('abort', onAbort);
      game.waiters.add(w);
    });
  }

  wakeWaiters(game) {
    for (const w of game.waiters) if (w.fresh(game.choice)) w.finish(null, game.choice);
  }

  // ---- housekeeping -------------------------------------------------------
  remove(game, reason) {
    this.games.delete(game.sid);
    if (game.code) this.codes.delete(game.code);
    clearInterval(game.pingTimer);
    for (const p of game.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'the game session ended' }); }
    for (const w of game.waiters) w.finish(new GameError('the game session ended (page closed); ask the player for a new code and call pair(code)'));
    if (game.sse) { try { game.sse.end(); } catch {} }
    log('session_ended', { sid: short(game.sid), reason, games: this.games.size });
  }

  sweep(now = Date.now()) {
    for (const game of this.games.values()) {
      if (game.code && now > game.codeExpiresAt) {
        this.codes.delete(game.code);
        game.code = null;
        log('code_expired', { sid: short(game.sid) });
      }
      if (game.offlineSince !== null && now - game.offlineSince > this.config.graceMs) this.remove(game, 'page_offline');
    }
    this.reportLimiter.sweep(now);
  }
}
