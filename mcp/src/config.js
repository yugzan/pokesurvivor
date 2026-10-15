// All tunables in one place. Every value can be overridden by an environment
// variable (tests use short timings). Times are in milliseconds.
const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export function loadConfig(overrides = {}) {
  return {
    port: num('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    codeTtlMs: num('CODE_TTL_MS', 10 * 60 * 1000),      // unpaired code lifetime
    graceMs: num('PAGE_GRACE_MS', 60 * 1000),           // page offline this long -> session reclaimed
    pingMs: num('PING_MS', 15 * 1000),                  // SSE keep-alive comment
    cmdTimeoutMs: num('CMD_TIMEOUT_MS', 5 * 1000),      // wait for page result
    mcpIdleMs: num('MCP_IDLE_MS', 30 * 60 * 1000),      // MCP session without requests -> closed
    sweepMs: num('SWEEP_MS', 5 * 1000),
    pageBodyMax: 256 * 1024,                            // protocol: 256 KiB
    mcpBodyMax: num('MCP_BODY_MAX', 256 * 1024),
    maxGames: num('MAX_GAMES', 5000),
    maxMcpSessions: num('MAX_MCP_SESSIONS', 5000),
    // rate limits (token buckets)
    reportPerSec: num('RL_REPORT_PER_SEC', 10),         // per sid
    sessionPerMin: num('RL_SESSION_PER_MIN', 10),       // POST /agent/session per IP
    streamPerMin: num('RL_STREAM_PER_MIN', 30),         // GET /agent/stream per IP
    mcpPerSec: num('RL_MCP_PER_SEC', 20),               // /mcp requests per IP
    pairFailLimit: num('PAIR_FAIL_LIMIT', 5),           // wrong codes before block
    pairBlockMs: num('PAIR_BLOCK_MS', 60 * 1000),
    pairGlobalFailPerMin: num('PAIR_GLOBAL_FAIL_PER_MIN', 60), // wrong codes from all IPs
    // Jev (TypeSafe System One), agent-jev only. The key comes from each MCP client.
    jevApiBase: (process.env.JEV_API_BASE || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    jevModel: process.env.JEV_MODEL || 'jev-1.13.0',
    jevTimeoutMs: num('JEV_TIMEOUT_MS', 8000),
    jevPerSec: num('JEV_PER_SEC', 2),                   // Jev calls per MCP session
    jevRetryMaxMs: num('JEV_RETRY_MAX_MS', 5000),       // cap on retry-after for 429/529
    ...overrides,
  };
}
