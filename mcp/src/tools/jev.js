// agent-jev: Jev (TypeSafe System One) tools. The user brings their own key
// (X-Jev-Key header, or the jev_key argument for clients without custom headers).
// The key is forwarded to TypeSafe only: never logged, stored past the call,
// or echoed back. auto_play keeps it in memory for the life of its loop only.
import { z } from 'zod';
import { ok, fail, guard, ToolError } from './result.js';
import { systemOne, makeThrottle, JevError, MISSING_KEY } from '../jev-client.js';
import { short } from '../log.js';

export const STRATEGY_MODES = {
  kite: 'Default. HP is healthy and enemies are around but not overwhelming: keep a safe distance while circling so the automatic attacks keep hitting them.',
  retreat: 'Danger: HP is low (roughly below 35%) or many enemies are very close and the player is getting surrounded. Run away from the nearest threats.',
  collect_xp: 'Calm: few or no enemies close to the player and XP pickups lie nearby. Go collect them to level up faster.',
  hunt_boss: 'A boss is present and the player is healthy and strong enough to take it down: move toward the boss to kill it.',
};

const KIND_HINT = {
  levelup: 'This is a level-up screen: each card adds a new move, upgrades or evolves a move the player has, or improves a stat.',
  item: 'This is a held-item screen: keep the current item or swap it for the new one.',
  bond: 'This is a bond screen: the chosen move will be cast together with others (a combo).',
};

const r2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined);

// Compact battle summary for Jev (English labels, Spanish names kept as-is).
export function summarizeState(state, choice) {
  const s = state && typeof state === 'object' ? state : {};
  const p = s.player && typeof s.player === 'object' ? s.player : {};
  const enemies = Array.isArray(s.enemies) ? s.enemies.filter((e) => e && typeof e === 'object') : [];
  const dist = (e) => (typeof e.dist === 'number' ? e.dist : Math.hypot(e.dx || 0, e.dy || 0));
  const within = (r) => enemies.filter((e) => dist(e) <= r).length;
  const boss = enemies.find((e) => e.boss);
  const pickups = Array.isArray(s.pickups) ? s.pickups : [];
  const out = {
    game: 'PokéSurvivor, a real-time survivor-like: the character attacks automatically, enemies swarm in waves, killing them drops XP gems; each level-up offers cards. Names and card texts are in Spanish.',
    phase: s.phase ?? null,
    time_survived_s: r2(s.time),
    player: {
      hp: p.hp, max_hp: p.maxHp,
      hp_percent: typeof p.hp === 'number' && p.maxHp > 0 ? Math.round((p.hp / p.maxHp) * 100) : undefined,
      level: p.level,
      moves: Array.isArray(p.moves) ? p.moves.map((m) => `${m?.name ?? m?.id} (lv ${m?.lv ?? '?'})`) : undefined,
      held_item: p.item ?? null,
      stats: p.stats && typeof p.stats === 'object' ? p.stats : undefined,
    },
    enemies: {
      visible_count: enemies.length,
      within_150px: within(150),
      within_300px: within(300),
      nearest_distance_px: enemies.length ? Math.round(dist(enemies[0])) : null,
      boss_present: !!boss,
      ...(boss ? { boss: { name: boss.name, distance_px: Math.round(dist(boss)), hp: boss.hp, max_hp: boss.maxHp } } : {}),
    },
    xp_pickups_nearby: pickups.length,
    autopilot_mode: s.autopilot?.mode ?? null,
  };
  if (choice) {
    out.choice_screen = { kind: choice.kind, ...(choice.mode ? { mode: choice.mode } : {}), ...(choice.step ? { step: choice.step } : {}), rerolls_left: choice.rerolls ?? 0 };
  }
  return out;
}

export const cardText = (c) => {
  const extra = [c.tag && `tag: ${c.tag}`, c.type && `type: ${c.type}`, c.key && `key: ${c.key}`].filter(Boolean).join(', ');
  return `${c.title ?? ''} — ${c.desc ?? ''}${extra ? ` (${extra})` : ''}`;
};

const cardsOf = (choice) => (Array.isArray(choice?.cards) ? choice.cards.filter((c) => c && Number.isInteger(c.index)) : []);

export function buildChoiceQuestions(choice, withReroll) {
  const cards = cardsOf(choice);
  const criteria = {};
  for (const c of cards) criteria[String(c.index)] = cardText(c);
  const questions = {
    best_card: {
      type: 'choice',
      instructions: `${KIND_HINT[choice.kind] || 'The game is paused on a choice screen.'} Which card should the player pick to best improve this run's survival and damage output, given the player's current moves, HP and the threats described in \`state\`? Each option is a card number; its description is the card text (in Spanish).`,
      criteria,
    },
  };
  if (withReroll) {
    questions.reroll = {
      type: 'noul',
      instructions: {
        offered_cards: Object.values(criteria),
        question: 'Are all of the `offered_cards` poor picks for this run, so the player should spend one of the limited rerolls to get a new set of cards instead of picking one?',
      },
      criteria: {
        true: 'None of the cards is worth taking now; rerolling is better.',
        false: 'At least one card is a reasonable pick; do not reroll.',
      },
    };
  }
  return questions;
}

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
    const a = res.answers?.best_card;
    if (!a || typeof a.probabilities !== 'object') throw new JevError('Jev returned no answer for the card question', 'bad_response');
    const probabilities = {};
    for (const c of cards) probabilities[String(c.index)] = r2(Number(a.probabilities[String(c.index)]) || 0);
    let pick = Number(a.choice);
    if (!Number.isInteger(pick) || !(String(pick) in probabilities)) {
      pick = Number(Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0][0]);
    }
    const out = { cid: choice.cid, probabilities, choice: pick, confidence: r2(a.confidence), model: res.model };
    const rr = res.answers?.reroll;
    if (withReroll && typeof rr?.noul === 'number') out.reroll_probability = r2(rr.noul);
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
    const res = await ask(key, summarizeState(game.state, null), {
      mode: {
        type: 'choice',
        instructions: 'The character moves by an autopilot while attacks are automatic. Which autopilot mode best keeps the player alive and gaining power right now, given HP, nearby enemies, bosses and XP pickups in `state`?',
        criteria: { ...STRATEGY_MODES },
      },
    });
    const a = res.answers?.mode;
    if (!a || !(a.choice in STRATEGY_MODES)) throw new JevError('Jev returned no usable strategy answer', 'bad_response');
    const probabilities = {};
    for (const m of Object.keys(STRATEGY_MODES)) probabilities[m] = r2(Number(a.probabilities?.[m]) || 0);
    return { mode: a.choice, probabilities, confidence: r2(a.confidence), model: res.model };
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
    const withReroll = choice.kind === 'levelup' && (choice.rerolls ?? 0) > 0;
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
    if (choice.kind !== 'levelup' || !((choice.rerolls ?? 0) > 0)) return fail('rerolling is not possible on this screen (only level-up screens with rerolls left)');
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
      'Returns {mode, probabilities: {mode: p}, confidence, model}. With apply=true it also switches the autopilot to that mode (like set_autopilot) and adds applied: true.' + KEY_NOTE,
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
    const withReroll = choice.kind === 'levelup' && (choice.rerolls ?? 0) > 0 && !a.justRerolled;
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
      '(like suggest_strategy) and applies it. It stops on auto_play(false), release(), when this MCP session closes, when the game is unpaired or its ' +
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
      startedAt: Date.now(), evaluations: 0, choices: 0, overlaysOnly: 0, rerolls: 0, strategies: 0,
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
      'overlays_only (low-confidence screens left to the player), rerolls, strategy_updates, autopilot_mode, last_error, stop_reason (when stopped)}. ' +
      'Does not call Jev and needs no key.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guard(async () => ok(statusOf(auto || last))));
}
