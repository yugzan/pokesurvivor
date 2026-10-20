// Remote MCP endpoint (Streamable HTTP, stateful: one transport + one McpServer
// per MCP session). Each MCP session can control only the game it paired.
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools/index.js';
import { ToolError } from './tools/result.js';
import { readBody, BodyTooLarge, sendJson, ipFromHeaders } from './http-util.js';
import { log, short } from './log.js';

export const SERVER_INFO = { name: 'pokesurvivor', version: '1.0.0' };

export const INSTRUCTIONS =
  'PokéSurvivor is a real-time survivor-like browser game: the character attacks automatically, enemies swarm in waves, ' +
  'killing them drops XP; on each level-up the game PAUSES and shows cards (new move, upgrade, evolution, stat) to pick from. ' +
  'You play alongside a human who has the game open. Workflow: 1) ask the player for the 6-character code and call pair(code); ' +
  '2) call set_autopilot (e.g. "kite") so the character keeps moving; 3) loop: wait_for_choice -> pick the best card with choose(index) ' +
  '(use reroll if no card helps and rerolls remain); between choices, check get_state and adjust the autopilot mode and the active move (set_active_move). ' +
  'Moves evolve: get_state player.moves shows lv/maxLv and, if it can evolve, evo {into, needs: the stat card to take once, ready}; at max level with that stat taken a gold EVOLUCIÓN card appears (big power jump), and stat cards tagged "Evoluciona <move>" unlock it. ' +
  'move(dx, dy, ms) is only a short manual override. release() hands control back to the player. Card texts are in Spanish. ' +
  'If the user has a TypeSafe Jev key (X-Jev-Key header or jev_key argument), evaluate_choices / should_reroll / suggest_strategy give ' +
  'Jev\'s probabilities for the cards and the movement mode, suggest_tactic lets Jev pick one of the tactics the page computes ' +
  '(slot, distance, target, gap, gems, trap...), and auto_play lets Jev play by itself (auto_play_status shows its progress).';

const jsonRpcError = (res, status, code, message) =>
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Jev-Key',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '600',
};


export class McpHub {
  constructor(config, games, { toolModules } = {}) {
    this.config = config;
    this.games = games;
    this.toolModules = toolModules;
    this.sessions = new Map();   // mcp session id -> entry
    this.pairFails = new Map();  // ip -> { count, blockedUntil, at }
    // Wrong codes from everyone in the current minute: caps brute force even if
    // someone reaches the origin directly and forges its IP header.
    this.globalFails = { count: 0, windowStart: 0 };
  }

  get size() { return this.sessions.size; }

  // ---- pairing brute-force guard (shared by all sessions) ----------------
  pairBlockedFor(ip, now = Date.now()) {
    const g = this.globalFails;
    if (now - g.windowStart < 60 * 1000 && g.count >= this.config.pairGlobalFailPerMin) return g.windowStart + 60 * 1000 - now;
    const f = this.pairFails.get(ip);
    return f && f.blockedUntil > now ? f.blockedUntil - now : 0;
  }
  recordPairFailure(ip, now = Date.now()) {
    const g = this.globalFails;
    if (now - g.windowStart >= 60 * 1000) { g.windowStart = now; g.count = 0; }
    g.count += 1;
    let f = this.pairFails.get(ip);
    if (!f) { f = { count: 0, blockedUntil: 0, at: now }; this.pairFails.set(ip, f); }
    f.count += 1;
    f.at = now;
    if (f.count >= this.config.pairFailLimit) {
      f.blockedUntil = now + this.config.pairBlockMs;
      f.count = 0;
      log('pair_blocked', { seconds: this.config.pairBlockMs / 1000 });
    } else {
      log('pair_failed');
    }
  }

  // ---- per-session context handed to every tool module -------------------
  makeContext(entry) {
    const hub = this;
    const games = this.games;
    const session = entry.session;
    const listeners = new Map();                 // event -> Set(fn)
    const ctx = {
      config: this.config,
      games,
      log,
      session,                                   // { id, sid, lastSeenCid, ip }
      // Read a header of the MCP request that carries this tool call
      // (e.g. ctx.header(extra, 'x-jev-key')). Never log the value.
      header: (extra, name) => {
        const v = extra?.requestInfo?.headers?.[String(name).toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
      clientIp: (extra) => ipFromHeaders(extra?.requestInfo?.headers) || session.ip,
      clientInfoName: () => entry.server.server.getClientVersion()?.name,
      pairBlockedFor: (ip) => hub.pairBlockedFor(ip),
      recordPairFailure: (ip) => hub.recordPairFailure(ip),
      // The game this session controls, or undefined (no error).
      currentGame: () => {
        const g = session.sid && games.get(session.sid);
        return g && g.owner === session.id ? g : undefined;
      },
      // The game this session controls; throws a ToolError explaining why not.
      requireGame: () => {
        if (!session.sid) throw new ToolError('not paired: call pair(code) first');
        const g = games.get(session.sid);
        if (!g) {
          session.sid = null;
          throw new ToolError('the game session ended (the page was closed or offline too long); ask the player for a new code and call pair(code)');
        }
        if (g.owner !== session.id) {
          session.sid = null;
          throw new ToolError('this game was paired by another agent session; ask the player for a new code and call pair(code)');
        }
        return g;
      },
      markSeen: (cid) => {
        if (typeof cid === 'number' && (session.lastSeenCid === null || cid > session.lastSeenCid)) session.lastSeenCid = cid;
      },
      // Send a protocol cmd (section 2) to the paired page and wait for its result.
      sendCmd: async (op, args) => games.sendCmd(ctx.requireGame(), op, args),
      // Session-local events between tool modules: 'closed' (MCP session ended),
      // 'release' (release() was called). Used by long-running tools such as auto_play.
      on: (event, fn) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => listeners.get(event)?.delete(fn);
      },
      emit: (event, ...args) => {
        for (const fn of [...(listeners.get(event) || [])]) {
          try { fn(...args); } catch (e) { log('listener_error', { event, message: String(e?.message || e).slice(0, 100) }); }
        }
      },
    };
    entry.ctx = ctx;
    return ctx;
  }

  async createSession(req, res, body, ip) {
    if (this.sessions.size >= this.config.maxMcpSessions) return jsonRpcError(res, 503, -32000, 'server busy, try again later');
    const entry = { session: { id: null, sid: null, lastSeenCid: null, ip }, lastSeen: Date.now(), closed: false };
    entry.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        entry.session.id = id;
        this.sessions.set(id, entry);
        log('mcp_session_created', { mcp: short(id), sessions: this.sessions.size });
      },
      onsessionclosed: (id) => this.closeSession(id, 'client_closed'),
      maxRequestBodySize: this.config.mcpBodyMax,
    });
    entry.transport.onclose = () => { if (entry.session.id) this.closeSession(entry.session.id, 'transport_closed'); };
    entry.server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    registerTools(entry.server, this.makeContext(entry), this.toolModules);
    await entry.server.connect(entry.transport);
    await entry.transport.handleRequest(req, res, body);
    if (!entry.session.id) { entry.closed = true; entry.server.close().catch(() => {}); }  // initialize rejected
  }

  closeSession(id, reason) {
    const entry = this.sessions.get(id);
    if (!entry || entry.closed) return;
    entry.closed = true;
    this.sessions.delete(id);
    const g = entry.session.sid && this.games.get(entry.session.sid);
    if (g) this.games.unpair(g, id, reason);
    entry.ctx?.emit('closed', reason);
    log('mcp_session_closed', { mcp: short(id), reason, sessions: this.sessions.size });
    entry.server.close().catch(() => {});
  }

  async handle(req, res, ip) {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) return jsonRpcError(res, 405, -32000, 'method not allowed');

    let body;
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req, this.config.mcpBodyMax);
        body = JSON.parse(raw);
      } catch (e) {
        if (e instanceof BodyTooLarge) return jsonRpcError(res, 413, -32000, 'request body too large');
        return jsonRpcError(res, 400, -32700, 'parse error');
      }
    }

    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid) {
      const entry = this.sessions.get(sid);
      if (!entry) return jsonRpcError(res, 404, -32001, 'session not found; reconnect (initialize) to start a new session');
      entry.lastSeen = Date.now();
      return entry.transport.handleRequest(req, res, body);
    }
    if (req.method === 'POST' && (isInitializeRequest(body) || (Array.isArray(body) && body.some(isInitializeRequest)))) {
      return this.createSession(req, res, body, ip);
    }
    return jsonRpcError(res, 400, -32000, 'bad request: missing Mcp-Session-Id (send initialize first)');
  }

  sweep(now = Date.now()) {
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastSeen > this.config.mcpIdleMs) {
        this.closeSession(id, 'idle');
      }
    }
    for (const [ip, f] of this.pairFails) {
      if (f.blockedUntil <= now && now - f.at > 10 * 60 * 1000) this.pairFails.delete(ip);
    }
  }

  async closeAll() {
    for (const id of [...this.sessions.keys()]) this.closeSession(id, 'shutdown');
  }
}
