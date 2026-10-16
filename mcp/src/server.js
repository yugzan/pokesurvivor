// PokéSurvivor MCP relay.
//   Game page  <-> /agent/session, /agent/stream (SSE), /agent/report   (protocol v1)
//   AI agents  <-> /mcp  (remote MCP, Streamable HTTP)
//   Game page  ->  /agent/jev  (Jev for the page itself, see jev-http.js)
//   Health:        /agent/health, /mcp/health
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { GameStore, GameError } from './games.js';
import { McpHub } from './mcp.js';
import { clientIp, readBody, BodyTooLarge, sendJson, sendStatus, RateLimiter } from './http-util.js';
import { log } from './log.js';
import { handleJev } from './jev-http.js';

export function createApp(overrides = {}, options = {}) {
  const config = loadConfig(overrides);
  const games = new GameStore(config);
  const hub = new McpHub(config, games, options);
  const sessionLimiter = new RateLimiter(config.sessionPerMin, 60_000);
  const streamLimiter = new RateLimiter(config.streamPerMin, 60_000);
  const mcpLimiter = new RateLimiter(config.mcpPerSec, 1000);
  const jevLimiter = new RateLimiter(config.jevPagePerSec, 1000);
  const jevGlobalLimiter = new RateLimiter(config.jevPageGlobalPerMin, 60_000);

  const tooMany = (res) => sendJson(res, 429, { error: 'too many requests' }, { 'Retry-After': '1' });

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const ip = clientIp(req);

    if (path === '/agent/health' || path === '/mcp/health') {
      return sendJson(res, 200, { ok: true, games: games.size, mcpSessions: hub.size });
    }

    if (path === '/mcp') {
      if (req.method !== 'OPTIONS' && !mcpLimiter.take(ip)) return tooMany(res);
      return hub.handle(req, res, ip);
    }

    if (path === '/agent/session') {
      if (req.method !== 'POST') return sendStatus(res, 405, { Allow: 'POST' });
      if (!sessionLimiter.take(ip)) return tooMany(res);
      try { await readBody(req, config.pageBodyMax); } catch (e) {
        if (e instanceof BodyTooLarge) return sendJson(res, 413, { error: 'body too large' });
        throw e;
      }
      try {
        return sendJson(res, 200, games.create());
      } catch (e) {
        if (e instanceof GameError) return sendJson(res, 503, { error: e.message });
        throw e;
      }
    }

    if (path === '/agent/stream') {
      if (req.method !== 'GET') return sendStatus(res, 405, { Allow: 'GET' });
      if (!streamLimiter.take(ip)) return tooMany(res);
      const game = games.get(url.searchParams.get('sid'));
      if (!game) return sendJson(res, 404, { error: 'unknown session' });
      return games.attachStream(game, res);
    }

    if (path === '/agent/report') {
      if (req.method !== 'POST') return sendStatus(res, 405, { Allow: 'POST' });
      let body;
      try {
        body = JSON.parse(await readBody(req, config.pageBodyMax));
      } catch (e) {
        if (e instanceof BodyTooLarge) return sendJson(res, 413, { error: 'body too large' });
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const game = body && typeof body === 'object' ? games.get(body.sid) : undefined;
      if (!game) return sendJson(res, 404, { error: 'unknown session' });
      if (!games.report(game, body)) return tooMany(res);
      return sendStatus(res, 204);
    }

    if (path === '/agent/jev') {
      return handleJev(req, res, { config, limiter: jevLimiter, globalLimiter: jevGlobalLimiter, ip });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      log('error', { path: req.url?.split('?')[0], message: String(e?.message || e).slice(0, 200) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.requestTimeout = 0;   // SSE and long MCP waits are long-lived responses
  server.headersTimeout = 30_000;

  const sweeper = setInterval(() => {
    const now = Date.now();
    games.sweep(now);
    hub.sweep(now);
    sessionLimiter.sweep(now);
    streamLimiter.sweep(now);
    mcpLimiter.sweep(now);
    jevLimiter.sweep(now);
    jevGlobalLimiter.sweep(now);
  }, config.sweepMs);
  sweeper.unref();

  return {
    config, games, hub, server,
    listen: (port = config.port, host = config.host) => new Promise((r) => server.listen(port, host, () => r(server.address().port))),
    close: async () => {
      clearInterval(sweeper);
      await hub.closeAll();
      for (const g of [...games.games.values()]) games.remove(g, 'shutdown');
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const app = createApp();
  const port = await app.listen();
  log('listening', { port });
  const stop = async (sig) => { log('shutdown', { sig }); await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
