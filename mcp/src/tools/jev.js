// agent-jev: Jev (TypeSafe System One) tools. The user brings their own key
// (X-Jev-Key header, or the jev_key argument for clients without custom headers).
// The key is forwarded to TypeSafe only: never logged, stored past the call,
// or echoed back. auto_play keeps it in memory for the life of its loop only.
import { z } from 'zod';
import { ok, fail, guard, ToolError } from './result.js';
import { systemOne, makeThrottle, JevError, MISSING_KEY } from '../jev-client.js';
import {
  summarizeState, buildChoiceQuestions, strategyQuestions, parseChoiceAnswer, parseStrategyAnswer, cardsOf, canReroll, r2,
  tacticQuestions, parseTacticAnswer, tacticsOf,
} from '../jev-core.js';
import { short } from '../log.js';

export { STRATEGY_MODES, summarizeState, cardText, buildChoiceQuestions } from '../jev-core.js';

export function register(server, ctx) {
  const throttle = makeThrottle(ctx.config.jevPerSec ?? 2);
  const jevKeyArg = z.string().max(1024).optional().describe(
    'Your TypeSafe Jev API key, only if your MCP client cannot send the X-Jev-Key header (the header wins when both are present). Never stored or logged.');

  const keyFrom = (extra, jev_key) => {
    const h = ctx.header(extra, 'x-jev-key');
    const k = (typeof h === 'string' && h.trim()) ? h.trim() : (typeof jev_key === 'string' ? jev_key.trim() : '');
    if (!k) throw new JevError(MISSING_KEY, 'missing_key');
    return k;
  };

  const ask = async (key, state, questions) => {
    await throttle();
    return systemOne({ key, state, questions, config: ctx.config });
  };

  // Shared by evaluate_choices and auto_play.
  async function evaluate(key, game, choice, { withReroll, overlay = true } = {}) {
    const cards = cardsOf(choice);
    if (!cards.length) throw new ToolError('the open choice screen has no cards to evaluate');
    const res = await ask(key, summarizeState(game.state, choice), buildChoiceQuestions(choice, withReroll));
    const out = parseChoiceAnswer(res, choice, withReroll);
    const { probabilities, choice: pick } = out;
    if (overlay) {
      try {
        const o = await ctx.sendCmd('overlay', { cid: choice.cid, probabilities, pick, source: 'jev' });
        out.overlay_shown = !!o?.ok;
      } catch { out.overlay_shown = false; }
    }
    return out;
  }

  async function strategy(key, game) {
    if (!game.state) throw new ToolError('no battle state yet (the page has not reported one); try again in a moment');
    return parseStrategyAnswer(await ask(key, summarizeState(game.state, null), strategyQuestions(game.state)));
  }

  const ro = { readOnlyHint: true, openWorldHint: true };
  const KEY_NOTE = ' Needs your own TypeSafe Jev key: set the X-Jev-Key header in your MCP client config, or pass jev_key.';

  server.registerTool('evaluate_choices', {
    title: 'Ask Jev which card to pick',
    description:
      'Ask Jev (TypeSafe\'s System One model) to rate every card on the open choice screen for this run\'s survival and damage output. ' +
      'Returns {cid, probabilities: {"<card index>": p} (sums to about 1), choice: <best card index>, confidence: 0..1, reroll_probability?, model}. ' +
      'reroll_probability (0..1) is included on level-up screens with rerolls left: how likely it is that no card is worth taking and a reroll is better. ' +
      'The probabilities are also drawn on the player\'s screen over the cards. It only advises: call choose(index) yourself to pick ' +
      '(a low confidence, e.g. < 0.35, means the cards are close). Needs a paired game with a choice screen open (see wait_for_choice).' + KEY_NOTE,
    inputSchema: { jev_key: jevKeyArg },
    annotations: ro,
  }, guard(async ({ jev_key }, extra) => {
    const key = keyFrom(extra, jev_key);
    const game = ctx.requireGame();
    const choice = game.choice;
    if (!choice) return fail('no choice screen is open right now; call wait_for_choice first');
    ctx.markSeen(choice.cid);
    const withReroll = canReroll(choice);
    return ok(await evaluate(key, game, choice, { withReroll }));
  }));

  server.registerTool('should_reroll', {
    title: 'Ask Jev whether to reroll',
    description:
      'Ask Jev whether every card on the open level-up screen is a poor pick, so spending a reroll is better. ' +
      'Returns {cid, reroll_probability: 0..1}; above about 0.7 a reroll is usually worth it (then call reroll()). ' +
      'Only for "levelup" screens with rerolls left (choice.rerolls > 0). evaluate_choices already includes this number, so you rarely need both.' + KEY_NOTE,
    inputSchema: { jev_key: jevKeyArg },
    annotations: ro,
  }, guard(async ({ jev_key }, extra) => {
    const key = keyFrom(extra, jev_key);
    const game = ctx.requireGame();
    const choice = game.choice;
    if (!choice) return fail('no choice screen is open right now; call wait_for_choice first');
    if (!canReroll(choice)) return fail('rerolling is not possible on this screen (only level-up screens with rerolls left)');
    if (!cardsOf(choice).length) return fail('the open choice screen has no cards to evaluate');
    const q = buildChoiceQuestions(choice, true);
    const res = await ask(key, summarizeState(game.state, choice), { reroll: q.reroll });
    const n = res.answers?.reroll?.noul;
    if (typeof n !== 'number') throw new JevError('Jev returned no answer for the reroll question', 'bad_response');
    ctx.sendCmd('mark', {}).catch(() => {});   // AI advice -> the run counts as AI-assisted (🧠)
    return ok({ cid: choice.cid, reroll_probability: r2(n), model: res.model });
  }));

  server.registerTool('suggest_strategy', {
    title: 'Ask Jev for a movement strategy',
    description:
      'Ask Jev which autopilot mode fits the current battle (from the latest get_state snapshot): ' +
      '"kite" (default, healthy HP, keep distance while circling), "retreat" (low HP or getting surrounded), ' +
      '"collect_xp" (few enemies close, XP gems nearby), "hunt_boss" (a boss is present and the player is strong enough). ' +
      'Returns {mode, probabilities: {mode: p}, confidence, model}. When the player has 2+ move slots (and no Choice Band), Jev also picks the slot ' +
      'whose moves fit the enemies best (type matchups, range): slot, slot_probabilities {"<slot>": p}, slot_confidence. ' +
      'With apply=true it also switches the autopilot to that mode (like set_autopilot) and the active move to that slot (like set_active_move), and adds applied: true.' + KEY_NOTE,
    inputSchema: {
      apply: z.boolean().optional().describe('true = also set the autopilot to the suggested mode. Default false (advice only).'),
      jev_key: jevKeyArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(async ({ apply, jev_key }, extra) => {
    const key = keyFrom(extra, jev_key);
    const game = ctx.requireGame();
    const out = await strategy(key, game);
    if (apply) {
      const r = await ctx.sendCmd('autopilot', { mode: out.mode });
      if (!r.ok) return fail(`Jev suggested "${out.mode}" but setting the autopilot failed: ${r.error}`);
      if (out.slot != null && out.slot !== game.state?.player?.active) {
        const r2s = await ctx.sendCmd('active', { slot: out.slot });
        if (!r2s.ok) out.slot_error = r2s.error;
      }
      out.applied = true;
    } else {
      ctx.sendCmd('mark', {}).catch(() => {});   // advice only -> AI-assisted (🧠)
    }
    return ok(out);
  }));

  server.registerTool('suggest_tactic', {
    title: 'Ask Jev for a tactic',
    description:
      'Ask Jev to pick one of the tactics the game page computed for the current battle (get_state → tactics.candidates). ' +
      'Each candidate is concrete and comes with numbers worked out from the real game rules, e.g. "fight with slot 2 keeping 200 px from ' +
      'Geodude (type multiplier 1.6, 3.1 s to kill)", "break out to the NE gap", "collect 6 XP of gems", "stand on the healing spring", ' +
      '"lure 3 chasers over the explosive trap", and map objects: enter the rift (legendary fight), touch an altar, open a locked chest, ' +
      'break a rock or chest, pick up a ticket or item, take cover from shooters, and rare targets (treasure thief, shiny, golden hour, lost pokemon). ' +
      'Every candidate also carries est_damage_next_3s, survives_next_3s and danger_now (simulated damage if the player follows it). The move slot is part of the tactic. ' +
      'Returns {tactic: id, label, probabilities: {id: p}, confidence, model}. With apply=true the autopilot (turned on if it was off) ' +
      'carries it out for apply_ms (default 4000) and adds applied: true; without apply it is advice only. Needs at least 2 candidates ' +
      '(during a run; the page reports them about 4 times per second).' + KEY_NOTE,
    inputSchema: {
      apply: z.boolean().optional().describe('true = also make the autopilot follow it now. Default false (advice only).'),
      apply_ms: z.number().int().min(500).max(15000).optional().describe('How long the autopilot follows the tactic when applied (ms). Default 4000.'),
      jev_key: jevKeyArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(async ({ apply, apply_ms, jev_key }, extra) => {
    const key = keyFrom(extra, jev_key);
    const game = ctx.requireGame();
    if (!game.state) return fail('no battle state yet (the page has not reported one); try again in a moment');
    if (tacticsOf(game.state).length < 2) return fail('no tactic candidates right now (they exist only during a run, with the player alive)');
    const out = parseTacticAnswer(await ask(key, summarizeState(game.state, null), tacticQuestions(game.state)), game.state);
    if (apply) {
      const r = await ctx.sendCmd('tactic', { id: out.tactic, ms: apply_ms ?? 4000 });
      if (!r.ok) return fail(`Jev picked "${out.tactic}" but the page could not apply it: ${r.error}`);
      out.applied = true;
    } else {
      ctx.sendCmd('mark', {}).catch(() => {});   // advice only -> AI-assisted (🧠)
    }
    return ok(out);
  }));

  // ---------------- auto_play: server-side loop for this MCP session ----------------
  let auto = null;      // running loop
  let last = null;      // last loop (for status after it stopped)

  const statusOf = (a) => (a ? {
    running: a.running,
    min_confidence: a.minConf,
    strategy_every_s: a.everyMs / 1000,
    started_at: new Date(a.startedAt).toISOString(),
    evaluations: a.evaluations,
    choices_made: a.choices,
    overlays_only: a.overlaysOnly,
    rerolls: a.rerolls,
    strategy_updates: a.strategies,
    slot_switches: a.slotSwitches,
    autopilot_mode: a.mode,
    last_error: a.lastError,
    ...(a.running ? {} : { stop_reason: a.stopReason }),
  } : { running: false, never_started: true });

  function stop(a, reason) {
    if (!a || !a.running) return;
    a.running = false;
    a.stopReason = reason;
    a.key = null;                          // drop the key as soon as the loop ends
    a.ctrl.abort();
    for (const off of a.offs) off();
    if (auto === a) auto = null;
    ctx.log('jev_auto_stopped', { mcp: short(ctx.session.id), reason: String(reason).slice(0, 60) });
  }

  const errorOf = (e) => (e instanceof ToolError || e?.name === 'GameError' ? e.message : 'internal error');

  async function handleChoice(a, game, choice) {
    const withReroll = canReroll(choice) && !a.justRerolled;
    a.justRerolled = false;
    let ev;
    try {
      ev = await evaluate(a.key, game, choice, { withReroll });
      a.evaluations++;
    } catch (e) {
      a.lastError = errorOf(e);
      if (e instanceof JevError && (e.kind === 'auth' || e.kind === 'missing_key')) stop(a, 'Jev key rejected');
      return;   // the player picks this one
    }
    if (!a.running) return;
    if (withReroll && (ev.reroll_probability ?? 0) > 0.7) {
      const r = await ctx.sendCmd('reroll', { cid: choice.cid });
      if (r.ok) { a.rerolls++; a.justRerolled = true; return; }   // the new cards come as a new cid
      a.lastError = `reroll failed: ${r.error}`;
    }
    if ((ev.confidence ?? 0) >= a.minConf) {
      const r = await ctx.sendCmd('choose', { index: ev.choice, cid: choice.cid });
      if (r.ok) { a.choices++; ctx.markSeen(choice.cid); } else a.lastError = `choose failed: ${r.error}`;
    } else {
      a.overlaysOnly++;                     // low confidence: the overlay stays for the player
    }
  }

  async function updateStrategy(a, game) {
    if (game.state?.phase !== 'playing') return;
    try {
      const s = await strategy(a.key, game);
      a.strategies++;
      if (!a.running) return;
      // Compare with the page, not our cache: a new run starts with the autopilot off.
      if (s.mode !== (game.state?.autopilot?.mode ?? a.mode)) {
        const r = await ctx.sendCmd('autopilot', { mode: s.mode });
        if (r.ok) a.mode = s.mode; else a.lastError = `autopilot failed: ${r.error}`;
      }
      if (s.slot != null && s.slot !== game.state?.player?.active) {
        const r = await ctx.sendCmd('active', { slot: s.slot });
        if (r.ok) a.slotSwitches++; else a.lastError = `active move failed: ${r.error}`;
      }
    } catch (e) {
      a.lastError = errorOf(e);
      if (e instanceof JevError && (e.kind === 'auth' || e.kind === 'missing_key')) stop(a, 'Jev key rejected');
    }
  }

  async function loop(a) {
    let handledCid = null;
    let nextStrategy = Date.now() + a.everyMs;
    while (a.running) {
      const game = ctx.currentGame();
      if (!game || game.sid !== a.sid) return stop(a, game ? 'paired with another game' : 'unpaired or the game session ended');
      let choice = null;
      try {
        choice = await ctx.games.waitForChoice(game, ctx.session.id, handledCid, Math.max(0, nextStrategy - Date.now()), a.ctrl.signal);
      } catch (e) {
        return stop(a, errorOf(e));
      }
      if (!a.running) return;
      if (choice) {
        handledCid = choice.cid;
        await handleChoice(a, game, choice);
      } else if (Date.now() >= nextStrategy) {
        await updateStrategy(a, game);
        nextStrategy = Date.now() + a.everyMs;
      }
    }
  }

  server.registerTool('auto_play', {
    title: 'Let Jev play on its own',
    description:
      'Start (enabled=true) or stop (enabled=false) a server-side loop that plays with Jev without further tool calls from you: ' +
      'it sets the autopilot to "kite", then on every new choice screen asks Jev (like evaluate_choices) and picks the most likely card when ' +
      'Jev\'s confidence >= min_confidence (otherwise it only draws the probabilities and leaves the pick to the player); on level-up screens it ' +
      'rerolls first when Jev rates a reroll above 0.7 (at most once per screen); every strategy_every_s seconds it asks Jev for the autopilot mode ' +
      'and, with 2+ move slots, the active move (like suggest_strategy) and applies both. It stops on auto_play(false), release(), when this MCP session closes, when the game is unpaired or its ' +
      'session ends, or if the key is rejected. The key is kept in memory only while the loop runs. Calling it again while running restarts it with ' +
      'the new settings. Check progress with auto_play_status. The run is marked 🤖 (played by AI) on the leaderboard.' + KEY_NOTE,
    inputSchema: {
      enabled: z.boolean().describe('true = start (or restart) the loop, false = stop it.'),
      min_confidence: z.number().min(0).max(1).optional().describe('Pick automatically only at or above this Jev confidence (0..1). Default 0.35.'),
      strategy_every_s: z.number().min(1).max(120).optional().describe('Seconds between autopilot strategy updates. Default 4.'),
      jev_key: jevKeyArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ enabled, min_confidence, strategy_every_s, jev_key }, extra) => {
    if (!enabled) {
      const a = auto || last;
      if (auto) stop(auto, 'auto_play(false)');
      return ok(statusOf(a));
    }
    const key = keyFrom(extra, jev_key);
    const game = ctx.requireGame();
    if (auto) stop(auto, 'restarted');
    const a = {
      running: true, key, sid: game.sid,
      minConf: min_confidence ?? 0.35, everyMs: (strategy_every_s ?? 4) * 1000,
      startedAt: Date.now(), evaluations: 0, choices: 0, overlaysOnly: 0, rerolls: 0, strategies: 0, slotSwitches: 0,
      mode: null, lastError: null, stopReason: null, justRerolled: false,
      ctrl: new AbortController(), offs: [],
    };
    a.offs.push(ctx.on('closed', () => stop(a, 'MCP session closed')));
    a.offs.push(ctx.on('release', () => stop(a, 'release() called')));
    auto = last = a;
    const r = await ctx.sendCmd('autopilot', { mode: 'kite' });
    if (r.ok) a.mode = 'kite'; else a.lastError = `autopilot failed: ${r.error}`;
    ctx.log('jev_auto_started', { mcp: short(ctx.session.id) });
    loop(a).catch((e) => { a.lastError = errorOf(e); stop(a, 'internal error'); });
    return ok(statusOf(a));
  }));

  server.registerTool('auto_play_status', {
    title: 'auto_play status',
    description:
      'Status of this session\'s auto_play loop: {running, min_confidence, strategy_every_s, started_at, evaluations, choices_made, ' +
      'overlays_only (low-confidence screens left to the player), rerolls, strategy_updates, slot_switches, autopilot_mode, last_error, stop_reason (when stopped)}. ' +
      'Does not call Jev and needs no key.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guard(async () => ok(statusOf(auto || last))));
}
