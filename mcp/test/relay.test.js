// End-to-end tests: fake page + real MCP client against the relay.
// In-process by default. With TEST_BASE_URL=http://localhost:18090 the
// protocol-level tests run against a deployed instance (through nginx) and the
// tests that need short timings or internal access are skipped.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { CODE_ALPHABET } from '../src/games.js';
import { FakePage, newAgent, sleep } from './helpers.js';

process.env.LOG_SILENT ??= '1';
const EXTERNAL = process.env.TEST_BASE_URL;
const internal = { skip: EXTERNAL ? 'needs an in-process server' : false };
// Grace period of the server under test. External runs set TEST_GRACE_MS=60000 to
// check the real 60 s reclaim (takes about 70 s); otherwise that test is skipped there.
const GRACE = EXTERNAL ? Number(process.env.TEST_GRACE_MS || 0) : 500;
const SWEEP = EXTERNAL ? 5000 : 100;
const graceTest = { skip: GRACE ? false : 'set TEST_GRACE_MS to run against an external server', timeout: GRACE + SWEEP + 30_000 };

async function startApp(overrides) {
  const app = createApp({ sweepMs: 100, sessionPerMin: 1000, mcpPerSec: 1000, ...overrides });
  const port = await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${port}` };
}

describe('relay', () => {
  let app, base;
  before(async () => {
    if (EXTERNAL) base = EXTERNAL.replace(/\/$/, '');
    else ({ app, base } = await startApp({ graceMs: GRACE, cmdTimeoutMs: 800 }));
  });
  after(async () => { await app?.close(); });

  test('health endpoints answer 200', async () => {
    for (const p of ['/agent/health', '/mcp/health']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
    }
  });

  test('POST /agent/session returns sid, code and expiry', async () => {
    const page = await new FakePage(base).createSession();
    assert.match(page.sid, /^[0-9a-f]{32}$/);
    assert.equal(page.code.length, 6);
    for (const ch of page.code) assert.ok(CODE_ALPHABET.includes(ch), ch);
    const ttl = page.expiresAt - Date.now();
    assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000 + 1000, `ttl ${ttl}`);
  });

  test('report with unknown sid -> 404, too large body -> 413, unknown stream sid -> 404', async () => {
    let r = await fetch(`${base}/agent/report`, { method: 'POST', body: JSON.stringify({ sid: 'nope', state: {} }) });
    assert.equal(r.status, 404);
    const page = await new FakePage(base).createSession();
    r = await fetch(`${base}/agent/report`, { method: 'POST', body: JSON.stringify({ sid: page.sid, state: { pad: 'x'.repeat(300 * 1024) } }) });
    assert.equal(r.status, 413);
    r = await fetch(`${base}/agent/stream?sid=nope`);
    assert.equal(r.status, 404);
  });

  test('full flow: pair, state, wait_for_choice, choose, isolation, unpair', async () => {
    const page = await new FakePage(base).createSession();
    const res = await page.connect();
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.deepEqual(page.events[0], { event: 'hello', data: { paired: false } });
    assert.equal(await page.report({ state: { phase: 'menu' } }), 204);

    const agent = await newAgent(base);
    const tools = (await agent.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['choose', 'get_choice', 'get_state', 'move', 'pair', 'release', 'reroll', 'set_autopilot', 'wait_for_choice']);

    // not paired yet
    let r = await agent.call('get_state');
    assert.ok(r.isError);
    assert.equal(r.text, 'not paired: call pair(code) first');

    // wrong code rejected, right code accepted
    const wrong = page.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    r = await agent.call('pair', { code: wrong });
    assert.ok(r.isError);
    assert.match(r.text, /invalid or expired/);
    r = await agent.call('pair', { code: page.code.toLowerCase(), client_name: 'Claude' });
    assert.ok(!r.isError, r.text);
    assert.equal(r.value.paired, true);
    assert.equal(r.value.page_connected, true);
    assert.deepEqual((await page.waitEvent('paired')).data, { client: 'Claude' });

    // state
    const state = { phase: 'playing', time: 12, ai: 0, player: { x: 1, y: 2, hp: 50, maxHp: 60 }, enemies: [] };
    await page.report({ state });
    r = await agent.call('get_state');
    assert.deepEqual(r.value, state);
    r = await agent.call('get_choice');
    assert.equal(r.value, null);

    // wait_for_choice wakes when the page reports a choice
    const choice = { cid: 1, kind: 'levelup', rerolls: 1, cards: [{ index: 0, title: 'A', desc: 'a' }, { index: 1, title: 'B', desc: 'b' }] };
    const waiting = agent.call('wait_for_choice', { timeout_s: 5 });
    await sleep(300);
    await page.report({ choice });
    r = await waiting;
    assert.deepEqual(r.value, choice);

    // the same choice is not returned twice
    const t0 = Date.now();
    r = await agent.call('wait_for_choice', { timeout_s: 1 });
    assert.equal(r.value, null);
    assert.ok(Date.now() - t0 >= 900);

    // choose reaches the page with the current cid; the page's result comes back
    page.onCmd = (cmd) => ({ ok: true, data: {} });
    const before = page.events.length;
    r = await agent.call('choose', { index: 1 });
    assert.ok(!r.isError, r.text);
    assert.equal(r.value.ok, true);
    const cmd = (await page.waitEvent('cmd', 1000, before)).data;
    assert.equal(cmd.op, 'choose');
    assert.deepEqual(cmd.args, { index: 1, cid: 1 });
    assert.ok(typeof cmd.id === 'string' && cmd.id.length > 0);

    // page-side errors are surfaced
    page.onCmd = () => ({ ok: false, error: 'stale choice' });
    r = await agent.call('choose', { index: 0 });
    assert.ok(r.isError);
    assert.match(r.text, /stale choice/);
    // invalid index rejected locally
    r = await agent.call('choose', { index: 7 });
    assert.ok(r.isError);

    // other commands and their args
    page.onCmd = () => ({ ok: true, data: {} });
    const seen = [];
    page.listeners.add((e) => { if (e.event === 'cmd') seen.push(e.data); });
    assert.ok(!(await agent.call('reroll')).isError);
    assert.ok(!(await agent.call('move', { dx: 1, dy: 0, ms: 500 })).isError);
    assert.ok(!(await agent.call('set_autopilot', { mode: 'kite', weights: { enemy: 2 } })).isError);
    assert.ok(!(await agent.call('release')).isError);
    assert.deepEqual(seen.map((c) => [c.op, c.args]), [
      ['reroll', { cid: 1 }],
      ['move', { dx: 1, dy: 0, ms: 500 }],
      ['autopilot', { mode: 'kite', weights: { enemy: 2 } }],
      ['release', {}],
    ]);
    // schema validation
    assert.ok((await agent.call('move', { dx: 1, dy: 0, ms: 10 })).isError);
    assert.ok((await agent.call('set_autopilot', { mode: 'fly' })).isError);

    // choice closed -> choose fails clearly
    await page.report({ choice: null });
    r = await agent.call('choose', { index: 0 });
    assert.ok(r.isError);
    assert.match(r.text, /no choice screen/);

    // a second agent cannot reuse the consumed code, and stays isolated
    const other = await newAgent(base, 'other');
    r = await other.call('pair', { code: page.code });
    assert.ok(r.isError);
    r = await other.call('get_state');
    assert.equal(r.text, 'not paired: call pair(code) first');
    await other.close();

    // closing the MCP session tells the page
    const mark = page.events.length;
    await agent.close();
    await page.waitEvent('unpaired', 2000, mark);
    page.disconnect();
  });

  test('page that does not answer -> command times out', internal, async () => {
    const page = await new FakePage(base).createSession();
    await page.connect();
    const agent = await newAgent(base);
    assert.ok(!(await agent.call('pair', { code: page.code })).isError);
    page.onCmd = () => undefined; // silent
    const r = await agent.call('release');
    assert.ok(r.isError);
    assert.match(r.text, /did not answer/);
    await agent.close();
    page.disconnect();
  });

  test('page offline longer than the grace period -> session reclaimed', graceTest, async () => {
    const page = await new FakePage(base).createSession();
    await page.connect();
    const agent = await newAgent(base);
    assert.ok(!(await agent.call('pair', { code: page.code })).isError);
    page.disconnect();
    await sleep(GRACE * 0.4);
    assert.equal(await page.report({ state: { phase: 'menu' } }), 204, 'still alive inside the grace period');
    await sleep(GRACE * 0.6 + SWEEP + 300);
    assert.equal(await page.report({ state: { phase: 'menu' } }), 404);
    const r = await agent.call('get_state');
    assert.ok(r.isError);
    assert.match(r.text, /game session ended/);
    assert.equal((await agent.call('get_state')).text, 'not paired: call pair(code) first');
    await agent.close();
  });

  test('reconnecting inside the grace period keeps the session (hello says paired)', internal, async () => {
    const page = await new FakePage(base).createSession();
    await page.connect();
    const agent = await newAgent(base);
    assert.ok(!(await agent.call('pair', { code: page.code })).isError);
    page.disconnect();
    await sleep(200);
    const mark = page.events.length;
    await page.connect();
    assert.deepEqual(page.events[mark], { event: 'hello', data: { paired: true } });
    await sleep(800);
    assert.equal(await page.report({ state: { phase: 'menu' } }), 204);
    await agent.close();
    page.disconnect();
  });

  test('takeover: a newer pair on the same game fails the old session', internal, async () => {
    const page = await new FakePage(base).createSession();
    await page.connect();
    const a = await newAgent(base, 'a');
    const b = await newAgent(base, 'b');
    assert.ok(!(await a.call('pair', { code: page.code })).isError);
    // Simulate a fresh code on the same game session (not reachable through protocol v1).
    const game = app.games.get(page.sid);
    game.code = 'ZZZZZZ'; game.codeExpiresAt = Date.now() + 60_000; app.games.codes.set('ZZZZZZ', page.sid);
    const waiting = a.call('wait_for_choice', { timeout_s: 5 });
    await sleep(100);
    assert.ok(!(await b.call('pair', { code: 'ZZZZZZ' })).isError);
    const r = await waiting;
    assert.ok(r.isError);
    assert.match(r.text, /paired by another agent/);
    assert.match((await a.call('get_state')).text, /paired by another agent/);
    assert.match((await a.call('get_state')).text, /not paired/);
    assert.ok(!(await b.call('get_state')).isError);
    await a.close(); await b.close(); page.disconnect();
  });
});

describe('abuse limits', { skip: EXTERNAL ? 'needs an in-process server' : false }, () => {
  test('5 wrong codes block pairing from that IP', async () => {
    const { app, base } = await startApp({ pairBlockMs: 1500 });
    const page = await new FakePage(base).createSession();
    const agent = await newAgent(base);
    for (let i = 0; i < 5; i++) assert.match((await agent.call('pair', { code: 'WRONG' + i })).text, /invalid or expired/);
    let r = await agent.call('pair', { code: page.code });
    assert.match(r.text, /too many wrong pairing codes/);
    await sleep(1600);
    r = await agent.call('pair', { code: page.code });
    assert.ok(!r.isError, r.text);
    await agent.close();
    await app.close();
  });

  test('forged X-Forwarded-For / CF-Connecting-IP do not dodge the block', async () => {
    const { app, base } = await startApp({ pairBlockMs: 60_000 });
    const page = await new FakePage(base).createSession();
    for (let i = 0; i < 5; i++) {
      const a = await newAgent(base, 'spoof', { 'X-Forwarded-For': `10.9.${i}.1`, 'CF-Connecting-IP': `10.8.${i}.1` });
      assert.match((await a.call('pair', { code: 'WRONG' + i })).text, /invalid or expired/);
      await a.close();
    }
    const a = await newAgent(base, 'spoof', { 'X-Forwarded-For': '10.9.99.1', 'CF-Connecting-IP': '10.8.99.1' });
    assert.match((await a.call('pair', { code: page.code })).text, /too many wrong pairing codes/);
    await a.close();
    await app.close();
  });

  test('wrong codes from many IPs hit the global cap', async () => {
    const { app, base } = await startApp({ pairGlobalFailPerMin: 8, pairFailLimit: 1000 });
    const page = await new FakePage(base).createSession();
    for (let i = 0; i < 8; i++) {
      const a = await newAgent(base, 'many', { 'X-Client-IP': `10.7.${i}.1` });
      assert.match((await a.call('pair', { code: 'WRONG' + i })).text, /invalid or expired/);
      await a.close();
    }
    const a = await newAgent(base, 'many', { 'X-Client-IP': '10.7.200.1' });
    assert.match((await a.call('pair', { code: page.code })).text, /too many wrong pairing codes/);
    await a.close();
    await app.close();
  });

  test('session creation is rate limited per IP', async () => {
    const { app, base } = await startApp({ sessionPerMin: 3 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${base}/agent/session`, { method: 'POST', body: '{}' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
    await app.close();
  });

  test('unpaired codes expire', async () => {
    const { app, base } = await startApp({ codeTtlMs: 200 });
    const page = await new FakePage(base).createSession();
    await page.connect();
    await sleep(400);
    const agent = await newAgent(base);
    assert.match((await agent.call('pair', { code: page.code })).text, /invalid or expired/);
    await agent.close();
    page.disconnect();
    await app.close();
  });

  test('SSE ping comment is sent', async () => {
    const { app, base } = await startApp({ pingMs: 100 });
    const page = await new FakePage(base).createSession();
    await page.connect();
    await sleep(350);
    assert.ok(page.pings >= 2, `pings ${page.pings}`);
    page.disconnect();
    await app.close();
  });
});
