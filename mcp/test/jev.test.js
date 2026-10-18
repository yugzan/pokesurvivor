// Jev tools (agent-jev) against a fake TypeSafe server on localhost.
// JEV_LIVE_KEY=<key> additionally runs one evaluate_choices against the real API.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { MISSING_KEY } from '../src/jev-client.js';
import { FakePage, newAgent, sleep } from './helpers.js';

process.env.LOG_SILENT ??= '1';
const HEADER_KEY = 'sk-test-HEADER-7f3a9c';
const PARAM_KEY = 'sk-test-PARAM-2b8d41';
const BAD_KEY = 'sk-test-BAD-0e5577';
const ALL_KEYS = [HEADER_KEY, PARAM_KEY, BAD_KEY];

// ---- fake TypeSafe ---------------------------------------------------------
function answerFor(body, opts = {}) {
  const answers = {};
  for (const [id, q] of Object.entries(body.questions || {})) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const probs = {};
      const best = opts.best ?? keys[keys.length > 1 ? 1 : 0];
      for (const k of keys) probs[k] = k === best ? 0.7 : 0.3 / (keys.length - 1 || 1);
      answers[id] = { type: 'choice', choice: best, probabilities: probs, confidence: opts.confidence ?? 0.6 };
    } else if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: opts.noul ?? 0.2 };
    }
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 0 } };
}

async function startFakeTypeSafe() {
  const fake = { requests: [], handler: null };
  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      const entry = { t: Date.now(), method: req.method, url: req.url, headers: req.headers, body };
      fake.requests.push(entry);
      const r = (fake.handler && (await fake.handler(body, entry, fake.requests.length))) || { status: 200, json: answerFor(body) };
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  fake.base = `http://127.0.0.1:${fake.server.address().port}`;
  return fake;
}

// ---- game fixtures -----------------------------------------------------------
const STATE = {
  phase: 'playing', time: 95.4, ai: 0,
  player: { x: 0, y: 0, hp: 62, maxHp: 100, level: 7, xp: 10, xpNext: 40, kills: 120,
    moves: [{ id: 'ember', name: 'Ascuas', lv: 3 }], item: null, stats: { atk: 1.2, spd: 1 } },
  enemies: [{ dx: 40, dy: 0, dist: 40, hp: 10, maxHp: 10, boss: false, name: 'Rattata' },
    { dx: 0, dy: 400, dist: 400, hp: 900, maxHp: 1000, boss: true, name: 'Onix' }],
  pickups: [{ dx: 5, dy: 5, kind: 'xp' }],
  autopilot: { mode: 'off', weights: {} },
};
const choiceOf = (cid, rerolls = 1) => ({
  cid, kind: 'levelup', rerolls,
  cards: [
    { index: 0, key: 'up:ember', type: 'up', title: 'Ascuas Nv.4', desc: 'Más daño de fuego.', tag: 'Fuego' },
    { index: 1, key: 'new:surf', type: 'new', title: 'Surf', desc: 'Una ola que empuja a los enemigos.', tag: 'Agua' },
    { index: 2, key: 'stat:hp', type: 'stat', title: 'Vida +10%', desc: 'Aumenta la vida máxima.' },
  ],
});

describe('jev tools', () => {
  let fake, app, base;
  before(async () => {
    fake = await startFakeTypeSafe();
    process.env.JEV_API_BASE = fake.base;          // read by loadConfig
    app = createApp({ sweepMs: 100, sessionPerMin: 1000, mcpPerSec: 1000, cmdTimeoutMs: 800, jevTimeoutMs: 1500 });
    base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
  });
  after(async () => { await app?.close(); fake?.server.close(); });

  // A connected page with a choice on screen, answering every cmd with ok.
  async function setup({ headers = { 'X-Jev-Key': HEADER_KEY }, choice = choiceOf(1) } = {}) {
    fake.handler = null;
    fake.requests.length = 0;
    const page = await new FakePage(base).createSession();
    await page.connect();
    page.cmds = [];
    page.onCmd = async (cmd) => {
      page.cmds.push(cmd);
      if (cmd.op === 'choose') { await page.report({ choice: null }); return { ok: true, data: { cid: cmd.args.cid, index: cmd.args.index } }; }
      if (cmd.op === 'reroll') {
        const next = choiceOf(cmd.args.cid + 1, 0);
        next.cards[0] = { ...next.cards[0], title: 'Lanzallamas', key: 'evo:flamethrower', type: 'evo' };
        await page.report({ choice: next });
        return { ok: true, data: { cid: next.cid, rerolls: 0 } };
      }
      return { ok: true, data: {} };
    };
    await page.report({ state: STATE, choice });
    const agent = await newAgent(base, 'jev-test', headers);
    const r = await agent.call('pair', { code: page.code });
    assert.ok(!r.isError, r.text);
    return { page, agent };
  }

  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(20); }
    return false;
  };

  test('tools/list has the Jev tools with complete descriptions', async () => {
    const agent = await newAgent(base);
    const tools = (await agent.client.listTools()).tools;
    for (const name of ['evaluate_choices', 'should_reroll', 'suggest_strategy', 'suggest_tactic', 'auto_play', 'auto_play_status']) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, name);
      assert.ok(t.description.length > 150, `${name} description too short`);
      if (name !== 'auto_play_status') {
        assert.match(t.description, /X-Jev-Key/, name);
        assert.ok(t.inputSchema.properties.jev_key, `${name} has jev_key`);
      }
    }
    await agent.close();
  });

  test('evaluate_choices: request format, result and overlay on the page', async () => {
    const { page, agent } = await setup();
    const r = await agent.call('evaluate_choices');
    assert.ok(!r.isError, r.text);
    assert.equal(fake.requests.length, 1);
    const req = fake.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.headers.authorization, `Bearer ${HEADER_KEY}`);
    assert.match(req.headers['content-type'], /application\/json/);
    assert.equal(req.body.model, 'jev-1.13.0');
    const q = req.body.questions;
    assert.equal(q.best_card.type, 'choice');
    assert.equal(typeof q.best_card.instructions, 'string');
    assert.deepEqual(Object.keys(q.best_card.criteria), ['0', '1', '2']);
    assert.equal(q.best_card.criteria['1'], 'Surf — Una ola que empuja a los enemigos. (tag: Agua, type: new, key: new:surf)');
    assert.equal(q.reroll.type, 'noul');
    assert.deepEqual(Object.keys(q.reroll.criteria).sort(), ['false', 'true']);
    // compact state
    assert.equal(req.body.state.player.hp, 62);
    assert.equal(req.body.state.player.level, 7);
    assert.equal(req.body.state.enemies.visible_count, 2);
    assert.equal(req.body.state.enemies.nearest_distance_px, 40);
    assert.equal(req.body.state.enemies.boss_present, true);
    assert.equal(req.body.state.choice_screen.kind, 'levelup');
    assert.equal(req.body.state.time_survived_s, 95.4);

    assert.deepEqual(r.value.probabilities, { 0: 0.15, 1: 0.7, 2: 0.15 });
    assert.equal(r.value.choice, 1);
    assert.equal(r.value.cid, 1);
    assert.equal(r.value.confidence, 0.6);
    assert.equal(r.value.reroll_probability, 0.2);
    assert.equal(r.value.model, 'jev-1.13.0');
    assert.equal(r.value.overlay_shown, true);
    const ov = page.events.find((e) => e.event === 'cmd' && e.data.op === 'overlay');
    assert.ok(ov, 'overlay cmd sent');
    assert.deepEqual(ov.data.args, { cid: 1, probabilities: { 0: 0.15, 1: 0.7, 2: 0.15 }, pick: 1, source: 'jev' });
    await agent.close(); page.disconnect();
  });

  test('no reroll question without rerolls; overlay failure does not break the result', async () => {
    const { page, agent } = await setup({ choice: choiceOf(1, 0) });
    page.onCmd = async () => ({ ok: false, error: 'stale choice' });
    const r = await agent.call('evaluate_choices');
    assert.ok(!r.isError, r.text);
    assert.equal(fake.requests[0].body.questions.reroll, undefined);
    assert.equal(r.value.reroll_probability, undefined);
    assert.equal(r.value.overlay_shown, false);
    assert.equal(r.value.choice, 1);
    await agent.close(); page.disconnect();
  });

  test('key sources: jev_key argument, and the header wins over it', async () => {
    let { page, agent } = await setup({ headers: null });
    let r = await agent.call('evaluate_choices', { jev_key: PARAM_KEY });
    assert.ok(!r.isError, r.text);
    assert.equal(fake.requests.at(-1).headers.authorization, `Bearer ${PARAM_KEY}`);
    await agent.close(); page.disconnect();

    ({ page, agent } = await setup());
    r = await agent.call('evaluate_choices', { jev_key: PARAM_KEY });
    assert.ok(!r.isError, r.text);
    assert.equal(fake.requests.at(-1).headers.authorization, `Bearer ${HEADER_KEY}`);
    await agent.close(); page.disconnect();
  });

  test('missing key -> clear error, no request to TypeSafe', async () => {
    const { page, agent } = await setup({ headers: null });
    for (const tool of ['evaluate_choices', 'should_reroll', 'suggest_strategy']) {
      const r = await agent.call(tool);
      assert.ok(r.isError, tool);
      assert.equal(r.text, MISSING_KEY);
    }
    const r = await agent.call('auto_play', { enabled: true });
    assert.ok(r.isError);
    assert.equal(r.text, MISSING_KEY);
    assert.equal(fake.requests.length, 0);
    await agent.close(); page.disconnect();
  });

  test('403 -> "Jev key rejected" without the key in the message', async () => {
    const { page, agent } = await setup({ headers: { 'X-Jev-Key': BAD_KEY } });
    fake.handler = () => ({ status: 403, json: { detail: { error_type: 'authentication_error', message: `invalid key ${BAD_KEY}` } } });
    const r = await agent.call('evaluate_choices');
    assert.ok(r.isError);
    assert.match(r.text, /^Jev key rejected/);
    assert.ok(!r.text.includes(BAD_KEY));
    fake.handler = () => ({ status: 401, json: { detail: 'unauthorized' } });
    const r2 = await agent.call('suggest_strategy');
    assert.match(r2.text, /^Jev key rejected \(HTTP 401\)/);
    await agent.close(); page.disconnect();
  });

  test('429 with retry-after is retried once; a second 429 is reported', async () => {
    const { page, agent } = await setup();
    fake.handler = (body, req, n) => (n === 1 ? { status: 429, headers: { 'Retry-After': '1' }, json: { detail: 'slow down' } } : null);
    const t0 = Date.now();
    let r = await agent.call('evaluate_choices');
    assert.ok(!r.isError, r.text);
    assert.equal(fake.requests.length, 2);
    assert.ok(fake.requests[1].t - fake.requests[0].t >= 900, 'waited for retry-after');
    assert.ok(Date.now() - t0 < 4000);

    fake.requests.length = 0;
    fake.handler = () => ({ status: 529, headers: { 'Retry-After': '2' }, json: {} });
    r = await agent.call('suggest_strategy');
    assert.ok(r.isError);
    assert.equal(r.text, 'Jev overloaded, retry after 2s');
    assert.equal(fake.requests.length, 2);
    fake.requests.length = 0;
    fake.handler = () => ({ status: 429, headers: { 'Retry-After': '1' }, json: {} });
    r = await agent.call('should_reroll');
    assert.equal(r.text, 'Jev rate limited, retry after 1s');
    await agent.close(); page.disconnect();
  });

  test('timeout -> no suggestion message', async () => {
    const { page, agent } = await setup();
    fake.handler = async () => { await sleep(2500); return null; };
    const r = await agent.call('evaluate_choices');
    assert.ok(r.isError);
    assert.match(r.text, /^Jev timed out after 1.5 s/);
    fake.handler = null;
    await agent.close(); page.disconnect();
  });

  test('should_reroll and suggest_strategy (apply)', async () => {
    const { page, agent } = await setup();
    let r = await agent.call('should_reroll');
    assert.ok(!r.isError, r.text);
    assert.deepEqual(Object.keys(fake.requests[0].body.questions), ['reroll']);
    assert.deepEqual(r.value, { cid: 1, reroll_probability: 0.2, model: 'jev-1.13.0' });
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'mark'), 2000), 'should_reroll marks the run as AI-assisted');

    fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: 'retreat', confidence: 0.55 }) });
    r = await agent.call('suggest_strategy', { apply: true });
    assert.ok(!r.isError, r.text);
    const q = fake.requests.at(-1).body.questions.mode;
    assert.equal(q.type, 'choice');
    assert.deepEqual(Object.keys(q.criteria), ['kite', 'retreat', 'collect_xp', 'hunt_boss']);
    assert.equal(r.value.mode, 'retreat');
    assert.equal(r.value.applied, true);
    assert.equal(r.value.confidence, 0.55);
    assert.ok(page.cmds.some((c) => c.op === 'autopilot' && c.args.mode === 'retreat'));
    const marks = page.cmds.filter((c) => c.op === 'mark').length;
    r = await agent.call('suggest_strategy');
    assert.ok(!r.isError, r.text);
    assert.ok(await waitFor(() => page.cmds.filter((c) => c.op === 'mark').length > marks, 2000), 'advice-only suggest_strategy marks the run');

    await page.report({ choice: choiceOf(2, 0) });
    r = await agent.call('should_reroll');
    assert.ok(r.isError);
    assert.match(r.text, /not possible/);
    await agent.close(); page.disconnect();
  });

  test('suggest_strategy with 2+ move slots also picks the active slot (apply -> active cmd)', async () => {
    const { page, agent } = await setup({ choice: null });
    const SLOTS = { ...STATE, enemies: STATE.enemies.map((e) => ({ ...e, types: e.boss ? ['rock', 'ground'] : ['normal', 'flying'] })),
      player: { ...STATE.player, active: 0, slots: [
        { index: 0, active: true, moves: [{ id: 'ember', name: 'Ascuas', lv: 3, type: 'fire', kind: 'projectile', range: 300, cd: 0.8 }] },
        { index: 1, active: false, moves: [{ id: 'surf', name: 'Surf', lv: 1, type: 'water', kind: 'nova', radius: 120, cd: 2 }] },
      ] } };
    await page.report({ state: SLOTS });
    fake.handler = (body) => ({ status: 200, json: answerFor(body) });      // picks the 2nd option: retreat / slot 1
    let r = await agent.call('suggest_strategy', { apply: true });
    assert.ok(!r.isError, r.text);
    const sent = fake.requests.at(-1).body;
    assert.deepEqual(Object.keys(sent.questions).sort(), ['mode', 'which_slot']);
    assert.deepEqual(Object.keys(sent.questions.which_slot.criteria), ['0', '1']);
    assert.match(sent.questions.which_slot.criteria['1'], /Surf \(water, nova, radius 120px, cooldown 2s, lv 1\)/);
    assert.deepEqual(sent.state.enemies.types_within_300px, { normal: 1, flying: 1 });
    assert.equal(sent.state.player.active_slot, 0);
    assert.equal(r.value.slot, 1);
    assert.deepEqual(r.value.slot_probabilities, { 0: 0.3, 1: 0.7 });
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'active' && c.args.slot === 1), 2000), 'active cmd sent');
    // Choice Band (locked) or a single slot: no slot question
    await page.report({ state: { ...SLOTS, player: { ...SLOTS.player, locked: true } } });
    r = await agent.call('suggest_strategy');
    assert.deepEqual(Object.keys(fake.requests.at(-1).body.questions), ['mode']);
    assert.equal(r.value.slot, undefined);
    // auto_play switches the slot too
    await page.report({ state: { ...SLOTS, autopilot: { mode: 'retreat', weights: {} } } });
    const before = page.cmds.filter((c) => c.op === 'active').length;
    await agent.call('auto_play', { enabled: true, strategy_every_s: 1 });
    assert.ok(await waitFor(() => page.cmds.filter((c) => c.op === 'active').length > before, 3000), 'auto_play switched the slot');
    const st = await agent.call('auto_play_status');
    assert.ok(st.value.slot_switches >= 1, st.text);
    await agent.call('auto_play', { enabled: false });
    await agent.close(); page.disconnect();
  });

  test('suggest_tactic: asks Jev to pick one of the page\'s tactics (numbers in the criteria), apply -> tactic cmd', async () => {
    const { page, agent } = await setup({ choice: null });
    // No candidates yet -> clear error, no request to TypeSafe.
    let r = await agent.call('suggest_tactic');
    assert.ok(r.isError);
    assert.match(r.text, /no tactic candidates/);
    assert.equal(fake.requests.length, 0);
    const TAC = { ...STATE, tactics: { plan: 'fight_s0', candidates: [
      { id: 'fight_s0', kind: 'fight', label: 'Fight with slot 1 (Ascuas): keep 200 px from Rattata (normal)', score: 0.6,
        numbers: { slot: 1, dps_vs_nearby: 52, type_multiplier: 1, target_seconds_to_kill: 0.4, target_outruns_you: false } },
      { id: 'evade', kind: 'evade', label: 'Break out to the NE gap and regroup', score: 0.3, numbers: { surrounded_sectors_of_16: 9, gap_direction: 'NE' } },
      { id: 'collect', kind: 'collect', label: 'Collect 6 XP worth of gems 120 px to the E', score: 0.2, numbers: { xp_value: 6 } },
    ] } };
    await page.report({ state: TAC });
    fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: 'evade', confidence: 0.66 }) });
    r = await agent.call('suggest_tactic', { apply: true, apply_ms: 3000 });
    assert.ok(!r.isError, r.text);
    const sent = fake.requests.at(-1).body;
    assert.deepEqual(Object.keys(sent.questions), ['tactic']);
    const q = sent.questions.tactic;
    assert.equal(q.type, 'choice');
    assert.deepEqual(Object.keys(q.criteria), ['fight_s0', 'evade', 'collect']);
    assert.match(q.criteria.fight_s0, /keep 200 px from Rattata .*\| slot=1, dps_vs_nearby=52, type_multiplier=1, target_seconds_to_kill=0.4, target_outruns_you=false/);
    assert.match(q.instructions, /Only the moves in the ACTIVE slot attack/);
    assert.equal(sent.state.current_tactic, 'fight_s0');
    assert.deepEqual(r.value, { tactic: 'evade', label: 'Break out to the NE gap and regroup', probabilities: { fight_s0: 0.15, evade: 0.7, collect: 0.15 }, confidence: 0.66, model: 'jev-1.13.0', applied: true });
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'tactic' && c.args.id === 'evade' && c.args.ms === 3000), 2000), 'tactic cmd sent');
    // Advice only: marks the run, no tactic cmd.
    const before = page.cmds.filter((c) => c.op === 'tactic').length;
    r = await agent.call('suggest_tactic');
    assert.ok(!r.isError, r.text);
    assert.equal(r.value.applied, undefined);
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'mark'), 2000));
    assert.equal(page.cmds.filter((c) => c.op === 'tactic').length, before);
    await agent.close(); page.disconnect();
  });

  test('per-session rate limit: at most 2 Jev calls per second', async () => {
    const { page, agent } = await setup({ choice: choiceOf(1, 0) });
    await Promise.all([1, 2, 3, 4, 5].map(() => agent.call('suggest_strategy')));
    const ts = fake.requests.map((r) => r.t);
    assert.equal(ts.length, 5);
    for (let i = 2; i < ts.length; i++) assert.ok(ts[i] - ts[i - 2] >= 950, `calls ${i - 2} and ${i} only ${ts[i] - ts[i - 2]} ms apart`);
    await agent.close(); page.disconnect();
  });

  test('auto_play: picks on high confidence, only overlays on low confidence', async () => {
    const { page, agent } = await setup({ choice: choiceOf(1, 0) });
    fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: '2', confidence: 0.9 }) });
    let r = await agent.call('auto_play', { enabled: true, strategy_every_s: 60 });
    assert.ok(!r.isError, r.text);
    assert.equal(r.value.running, true);
    assert.ok(page.cmds.some((c) => c.op === 'autopilot' && c.args.mode === 'kite'), 'kite set first');
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'choose')), 'choose sent');
    const ch = page.cmds.find((c) => c.op === 'choose');
    assert.deepEqual(ch.args, { index: 2, cid: 1 });

    // next screen, low confidence -> overlay only
    fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: '0', confidence: 0.2 }) });
    await page.report({ choice: choiceOf(2, 0) });
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'overlay' && c.args.cid === 2)), 'overlay for cid 2');
    await sleep(150);
    assert.equal(page.cmds.filter((c) => c.op === 'choose').length, 1, 'no pick at low confidence');
    r = await agent.call('auto_play_status');
    assert.equal(r.value.running, true);
    assert.equal(r.value.choices_made, 1);
    assert.equal(r.value.overlays_only, 1);
    assert.equal(r.value.evaluations, 2);
    assert.ok(!r.text.includes(HEADER_KEY));

    r = await agent.call('auto_play', { enabled: false });
    assert.equal(r.value.running, false);
    assert.equal(r.value.stop_reason, 'auto_play(false)');
    await agent.close(); page.disconnect();
  });

  test('auto_play: rerolls once when Jev rates the cards poor, then picks', async () => {
    const { page, agent } = await setup({ choice: choiceOf(1, 1) });
    fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: '0', confidence: 0.8, noul: 0.9 }) });
    await agent.call('auto_play', { enabled: true, strategy_every_s: 60 });
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'choose')), 'choose sent');
    const ops = page.cmds.map((c) => c.op).filter((o) => o !== 'overlay');
    assert.deepEqual(ops, ['autopilot', 'reroll', 'choose']);
    assert.deepEqual(page.cmds.find((c) => c.op === 'choose').args, { index: 0, cid: 2 });
    // the evaluation after the reroll did not ask about rerolling again
    assert.equal(fake.requests.at(-1).body.questions.reroll, undefined);
    const st = await agent.call('auto_play_status');
    assert.equal(st.value.rerolls, 1);
    await agent.call('release');
    const st2 = await agent.call('auto_play_status');
    assert.equal(st2.value.running, false);
    assert.equal(st2.value.stop_reason, 'release() called');
    await agent.close(); page.disconnect();
  });

  test('auto_play: strategy updates on the timer', async () => {
    const { page, agent } = await setup({ choice: null });
    fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: 'collect_xp', confidence: 0.7 }) });
    await agent.call('auto_play', { enabled: true, strategy_every_s: 1 });
    assert.ok(await waitFor(() => page.cmds.some((c) => c.op === 'autopilot' && c.args.mode === 'collect_xp'), 3000), 'strategy applied');
    const st = await agent.call('auto_play_status');
    assert.ok(st.value.strategy_updates >= 1);
    assert.equal(st.value.autopilot_mode, 'collect_xp');
    // New run: the page reports its autopilot off again -> auto_play sets it back.
    const before = page.cmds.filter((c) => c.op === 'autopilot').length;
    await page.report({ state: { phase: 'playing', time: 1, ai: 0, player: { hp: 90, maxHp: 90, level: 1 }, enemies: [], pickups: [], autopilot: { mode: 'off' } } });
    assert.ok(await waitFor(() => page.cmds.filter((c) => c.op === 'autopilot').length > before, 3000), 'autopilot re-applied on a new run');
    await agent.call('auto_play', { enabled: false });
    await agent.close(); page.disconnect();
  });

  test('auto_play stops when the MCP session closes', async () => {
    const { page, agent } = await setup({ choice: null });
    fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: '1', confidence: 0.9 }) });
    await agent.call('auto_play', { enabled: true, strategy_every_s: 60 });
    await agent.close();
    await page.waitEvent('unpaired', 2000);
    const before = fake.requests.length;
    await page.report({ choice: choiceOf(5, 0) });
    await sleep(400);
    assert.equal(fake.requests.length, before, 'no Jev call after the session closed');
    assert.ok(!page.cmds.some((c) => c.op === 'choose'));
    page.disconnect();
  });

  test('auto_play stops when the key is rejected', async () => {
    const { page, agent } = await setup({ headers: { 'X-Jev-Key': BAD_KEY }, choice: choiceOf(1, 0) });
    fake.handler = () => ({ status: 403, json: { detail: { error_type: 'authentication_error' } } });
    await agent.call('auto_play', { enabled: true, strategy_every_s: 60 });
    let st;
    for (let i = 0; i < 50; i++) {
      st = await agent.call('auto_play_status');
      if (!st.value.running) break;
      await sleep(50);
    }
    assert.equal(st.value.running, false);
    assert.equal(st.value.stop_reason, 'Jev key rejected');
    assert.match(st.value.last_error, /^Jev key rejected/);
    assert.ok(!st.text.includes(BAD_KEY));
    await agent.close(); page.disconnect();
  });

  test('logs never contain the key', async () => {
    const lines = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const cap = (...a) => lines.push(a.map(String).join(' '));
    const prevSilent = process.env.LOG_SILENT;
    process.env.LOG_SILENT = '0';
    console.log = console.error = console.warn = console.info = cap;
    try {
      let { page, agent } = await setup();
      await agent.call('evaluate_choices');
      await agent.call('evaluate_choices', { jev_key: PARAM_KEY });
      fake.handler = (body) => ({ status: 200, json: answerFor(body, { best: '1', confidence: 0.9 }) });
      await agent.call('auto_play', { enabled: true, strategy_every_s: 60 });
      await waitFor(() => page.cmds.some((c) => c.op === 'choose'));
      await agent.call('auto_play', { enabled: false });
      fake.handler = () => ({ status: 403, json: { detail: `bad ${HEADER_KEY}` } });
      await agent.call('evaluate_choices');
      fake.handler = () => ({ status: 500, json: { detail: `boom ${HEADER_KEY}` } });
      const r = await agent.call('evaluate_choices');
      assert.ok(r.isError && !r.text.includes(HEADER_KEY), r.text);
      await agent.close(); page.disconnect();
      ({ page, agent } = await setup({ headers: null }));
      await agent.call('suggest_strategy', { jev_key: PARAM_KEY });
      await agent.close(); page.disconnect();
    } finally {
      Object.assign(console, orig);
      if (prevSilent === undefined) delete process.env.LOG_SILENT; else process.env.LOG_SILENT = prevSilent;
    }
    assert.ok(lines.length > 5, `captured ${lines.length} log lines`);
    assert.ok(lines.some((l) => l.includes('jev_auto_started')));
    for (const l of lines) for (const k of ALL_KEYS) assert.ok(!l.includes(k), `key leaked in log: ${l}`);
  });
});

describe('jev live API', { skip: process.env.JEV_LIVE_KEY ? false : 'set JEV_LIVE_KEY to call the real TypeSafe API' }, () => {
  test('evaluate_choices against api.typesafe.ai', { timeout: 30_000 }, async () => {
    const app = createApp({ sessionPerMin: 1000, mcpPerSec: 1000, jevApiBase: 'https://api.typesafe.ai', jevTimeoutMs: 15000 });
    const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
    try {
      const page = await new FakePage(base).createSession();
      await page.connect();
      page.onCmd = async () => ({ ok: true, data: {} });
      await page.report({ state: STATE, choice: choiceOf(1, 1) });
      const agent = await newAgent(base, 'jev-live', { 'X-Jev-Key': process.env.JEV_LIVE_KEY });
      await agent.call('pair', { code: page.code });
      const r = await agent.call('evaluate_choices');
      assert.ok(!r.isError, r.text);
      const sum = Object.values(r.value.probabilities).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 0.05, `sum ${sum}`);
      assert.ok([0, 1, 2].includes(r.value.choice));
      assert.equal(typeof r.value.reroll_probability, 'number');
      await agent.close(); page.disconnect();
    } finally { await app.close(); }
  });
});

// Map tactics (js/agent/tactics.js): their ids are valid and Jev gets the trade-off hint.
import { TACTIC_ID_RE, tacticQuestions } from '../src/jev-core.js';
describe('map tactics', () => {
  test('rift/altar/bigchest/break/loot/cover ids pass and appear in the question', () => {
    const ids = ['rift', 'altar', 'bigchest', 'break', 'loot', 'cover'];
    for (const id of ids) assert.match(id, TACTIC_ID_RE);
    const state = { tactics: { candidates: ids.map((id) => ({ id, kind: 'goto', label: `Do ${id}`, numbers: { distance_px: 100 } })) } };
    const q = tacticQuestions(state).tactic;
    assert.deepEqual(Object.keys(q.criteria), ids);
    assert.match(q.criteria.rift, /Do rift \| distance_px=100/);
    assert.match(q.instructions, /Map tactics \(rift, altar, bigchest, break, loot, cover\)/);
  });
});

// The page's real numbers for the map tactics (captured from the game, 5 attack slots, choice band,
// slot switch: test/fixtures/map-tactics.json) survive the server's limits untouched (16 numbers, 80 chars).
import { readFileSync } from 'node:fs';
import { sanitizeTactics, LIMITS } from '../src/jev-http.js';
describe('map tactics through sanitizeTactics', () => {
  const shapes = JSON.parse(readFileSync(new URL('./fixtures/map-tactics.json', import.meta.url), 'utf8'));
  test('every map tactic keeps all its numbers', () => {
    const ids = new Set(Object.values(shapes).map((c) => c.id));
    for (const id of ['rift', 'altar', 'bigchest', 'break', 'loot', 'cover']) assert.ok(ids.has(id), `fixture has ${id}`);
    for (const [name, c] of Object.entries(shapes)) {
      assert.ok(Object.keys(c.numbers).length <= LIMITS.numbers, `${name}: at most ${LIMITS.numbers} numbers`);
      const out = sanitizeTactics({ candidates: [c] }).candidates[0];
      assert.deepEqual(out.numbers, c.numbers, `${name}: nothing dropped or cut`);
    }
    const rift = shapes.rift.numbers;
    for (const k of ['est_seconds_to_kill', 'arena_time_limit_s', 'win_reward', 'lose_or_timeout', 'slot', 'dps_vs_legend']) assert.ok(k in rift, `rift.${k}`);
    assert.equal(shapes.rift_choiceband.numbers.slot_fixed, 'choice band');
    assert.equal(shapes.break_switch.numbers.switches_slot, true);
  });
});

// Danger numbers (est_damage_next_3s, survives_next_3s, danger_now) on every candidate, the group fight and the
// rare targets (thief, shiny, golden, lost, rift go/no-go numbers): captured from the game page, they pass the
// server's limits untouched, reach the question and feed the state's danger overview.
import { summarizeState, dangerOf } from '../src/jev-core.js';
import { sanitizeState } from '../src/jev-http.js';
describe('danger numbers and rare targets', () => {
  const shapes = JSON.parse(readFileSync(new URL('./fixtures/map-tactics.json', import.meta.url), 'utf8'));
  const DANGER = ['est_damage_next_3s', 'survives_next_3s', 'danger_now'];
  test('every candidate carries the shared danger numbers and nothing is dropped or cut', () => {
    for (const id of ['fight', 'evade', 'circle_kite', 'collect', 'heal', 'thief', 'shiny', 'golden', 'lost', 'lost_follow', 'rift_danger']) assert.ok(shapes[id], `fixture has ${id}`);
    for (const [name, c] of Object.entries(shapes)) {
      for (const k of DANGER) assert.ok(k in c.numbers, `${name}.${k}`);
      assert.equal(typeof c.numbers.est_damage_next_3s, 'number');
      assert.equal(typeof c.numbers.survives_next_3s, 'boolean');
      assert.ok(c.numbers.danger_now.length <= 80, `${name}: danger_now within 80 chars`);
      const out = sanitizeTactics({ candidates: [c] }).candidates[0];
      assert.deepEqual(out.numbers, c.numbers, `${name}: nothing dropped or cut`);
    }
  });
  test('fight describes the group; rare targets have their go/no-go numbers', () => {
    const f = shapes.fight.numbers;
    for (const k of ['group_within_250px', 'group_seconds_to_clear', 'est_damage_while_clearing', 'dps_vs_nearby']) assert.ok(k in f, `fight.${k}`);
    for (const k of ['seconds_until_escape', 'seconds_to_kill', 'seconds_to_get_in_range', 'can_catch_in_time', 'thief_flee_speed', 'your_speed', 'loot']) assert.ok(k in shapes.thief.numbers, `thief.${k}`);
    for (const k of ['reward', 'shiny_hp', 'seconds_to_kill', 'its_hit_damage_to_you', 'leaves_if_ignored']) assert.ok(k in shapes.shiny.numbers, `shiny.${k}`);
    for (const k of ['golden_within_420px', 'their_xp', 'event_seconds_left', 'est_seconds_to_kill_all']) assert.ok(k in shapes.golden.numbers, `golden.${k}`);
    for (const k of ['seconds_left', 'est_seconds_needed', 'pet_hp', 'reward', 'fail']) assert.ok(k in shapes.lost.numbers, `lost.${k}`);
    for (const k of ['legend_hit_damage_to_you', 'legend_hits_to_ko_you', 'est_seconds_to_kill', 'arena_time_limit_s']) assert.ok(k in shapes.rift_danger.numbers, `rift.${k}`);
  });
  test('the question has explicit thresholds and the state a danger overview', () => {
    const cands = ['fight', 'evade', 'thief', 'heal'].map((k) => ({ ...shapes[k], id: shapes[k].id }));
    const state = { tactics: { candidates: cands } };
    const q = tacticQuestions(state).tactic;
    assert.match(q.instructions, /never pick an option with survives_next_3s=false while another has true/);
    assert.match(q.instructions, /HP is below 35%/);
    assert.match(q.instructions, /invulnerable for 0\.45 s/);
    assert.match(q.criteria[shapes.fight.id], /est_damage_next_3s=\d+, survives_next_3s=(true|false), danger_now=HP /);
    const clean = sanitizeState(state);
    const sum = summarizeState(clean, null);
    const safest = cands.reduce((a, c) => (c.numbers.est_damage_next_3s < a.numbers.est_damage_next_3s ? c : a));
    assert.equal(sum.danger.lowest_damage_tactic, safest.id);
    assert.deepEqual(sum.danger.tactics_that_survive_next_3s, cands.filter((c) => c.numbers.survives_next_3s).map((c) => c.id));
    assert.equal(typeof sum.danger.now, 'string');
    assert.deepEqual(dangerOf({ candidates: [{ id: 'roam', numbers: {} }] }), {}, 'no danger numbers -> no overview');
  });
});

describe('slot question with the page\'s damage per slot', () => {
  test('stats.dps_slotN survives sanitizeState and is shown in which_slot', async () => {
    const { slotQuestion } = await import('../src/jev-core.js');
    const { sanitizeState } = await import('../src/jev-http.js');
    const stats = { spd: 116, atk: 1, cdMul: 1, crit: 0, reduction: 0, regen: 0, magnet: 78, xpMul: 1, bosses: 0, coins: 0, bonds: 0, rerolls: 1, slots: 2, maxMoves: 4, active: 0, dps_slot1: 41, dps_slot2: 180 };
    const state = sanitizeState({ phase: 'playing', player: { hp: 50, maxHp: 50, active: 0, stats, slots: [
      { index: 0, moves: [{ id: 'fire-spin', name: 'Giro Fuego', lv: 2, type: 'fire', kind: 'orbit', radius: 62, cd: 0.3 }] },
      { index: 1, moves: [{ id: 'flamethrower', name: 'Lanzallamas', lv: 3, type: 'fire', kind: 'cone', cd: 0.7 }] },
    ] } });
    assert.equal(Object.keys(state.player.stats).length, 17, 'no stat lost');
    const q = slotQuestion(state);
    assert.match(q.criteria['0'], /Giro Fuego .*\(estimated 41 damage\/s to the nearby enemies\)$/);
    assert.match(q.criteria['1'], /Lanzallamas .*\(estimated 180 damage\/s to the nearby enemies\)$/);
    const plain = slotQuestion(sanitizeState({ player: { slots: state.player.slots } }));
    assert.doesNotMatch(plain.criteria['0'], /estimated/, 'without the number, no claim');
  });
});
