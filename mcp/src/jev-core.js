// Jev (TypeSafe System One) questions and answers for PokéSurvivor, as pure
// functions: shared by the MCP tools (tools/jev.js) and the page endpoint
// POST /agent/jev (jev-http.js), so both ask Jev exactly the same questions.
import { JevError } from './jev-client.js';

export const STRATEGY_MODES = {
  kite: 'Default. HP is healthy and enemies are around but not overwhelming: keep a safe distance while circling so the automatic attacks keep hitting them.',
  retreat: 'Danger: HP is low (roughly below 35%) or many enemies are very close and the player is getting surrounded. Run away from the nearest threats.',
  collect_xp: 'Calm: few or no enemies close to the player and XP pickups lie nearby. Go collect them to level up faster.',
  hunt_boss: 'A boss is present and the player is healthy and strong enough to take it down: move toward the boss to kill it.',
};

const KIND_HINT = {
  levelup: 'This is a level-up screen: each card adds a new move, upgrades or evolves a move the player has, or improves a stat. ' +
    'Move evolution: a move at its max level (lv N/N) EVOLVES once the player has taken, at any time this run, the stat card it needs ' +
    '(see `player.moves`: "evolves into X at max level, needs stat card Y"); then a gold card tagged EVOLUCIÓN appears, a big power jump ' +
    '(about x1.6-1.9 damage plus extra projectiles/area). A stat card tagged "Evoluciona <move>" is the one that unlocks that evolution, ' +
    'and upgrading a move with an evolution toward its max level brings it closer.',
  item: 'This is a held-item screen: keep the current item or swap it for the new one.',
  bond: 'This is a bond screen: the chosen move will be cast together with others (a combo).',
};

export const r2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined);

// Compact battle summary for Jev (English labels, Spanish names kept as-is).
export function summarizeState(state, choice) {
  const s = state && typeof state === 'object' ? state : {};
  const p = s.player && typeof s.player === 'object' ? s.player : {};
  const enemies = Array.isArray(s.enemies) ? s.enemies.filter((e) => e && typeof e === 'object') : [];
  const dist = (e) => (typeof e.dist === 'number' ? e.dist : Math.hypot(e.dx || 0, e.dy || 0));
  const within = (r) => enemies.filter((e) => dist(e) <= r).length;
  const boss = enemies.find((e) => e.boss);
  const pickups = Array.isArray(s.pickups) ? s.pickups : [];
  // Enemy types (for type matchups): how many of each type within 300 px, and the nearest ones.
  const typesOf = (e) => (Array.isArray(e.types) ? e.types.filter((t) => typeof t === 'string') : []);
  const typeCount = {};
  for (const e of enemies) if (dist(e) <= 300) for (const t of typesOf(e)) typeCount[t] = (typeCount[t] || 0) + 1;
  const nearestTypes = enemies.slice(0, 5).map((e) => ({ types: typesOf(e), distance_px: Math.round(dist(e)) })).filter((e) => e.types.length);
  const slots = slotsOf(p);
  const out = {
    game: 'PokéSurvivor, a real-time survivor-like: the character attacks automatically, enemies swarm in waves, killing them drops XP gems; each level-up offers cards. Names and card texts are in Spanish.',
    phase: s.phase ?? null,
    time_survived_s: r2(s.time),
    player: {
      hp: p.hp, max_hp: p.maxHp,
      hp_percent: typeof p.hp === 'number' && p.maxHp > 0 ? Math.round((p.hp / p.maxHp) * 100) : undefined,
      level: p.level,
      moves: Array.isArray(p.moves) ? p.moves.map(moveLine) : undefined,
      held_item: p.item ?? null,
      ...(slots.length ? {
        move_slots: slots.map((g) => ({ slot: g.index, active: g.index === p.active, moves: g.moves.map(moveText) })),
        active_slot: Number.isInteger(p.active) ? p.active : null,
        ...(p.locked ? { active_slot_locked: true } : {}),
      } : {}),
      stats: p.stats && typeof p.stats === 'object' ? p.stats : undefined,
    },
    enemies: {
      visible_count: enemies.length,
      within_150px: within(150),
      within_300px: within(300),
      nearest_distance_px: enemies.length ? Math.round(dist(enemies[0])) : null,
      boss_present: !!boss,
      ...(boss ? { boss: { name: boss.name, distance_px: Math.round(dist(boss)), hp: boss.hp, max_hp: boss.maxHp } } : {}),
      ...(Object.keys(typeCount).length ? { types_within_300px: typeCount } : {}),
      ...(nearestTypes.length ? { nearest_types: nearestTypes } : {}),
    },
    xp_pickups_nearby: pickups.length,
    autopilot_mode: s.autopilot?.mode ?? null,
    ...(typeof s.tactics?.plan === 'string' ? { current_tactic: s.tactics.plan } : {}),
    ...dangerOf(s.tactics),
  };
  if (choice) {
    out.choice_screen = { kind: choice.kind, ...(choice.mode ? { mode: choice.mode } : {}), ...(choice.step ? { step: choice.step } : {}), rerolls_left: choice.rerolls ?? 0 };
  }
  return out;
}

// Danger overview from the tactic candidates' shared numbers (est_damage_next_3s, survives_next_3s,
// danger_now, computed on the page by js/agent/tactics.js): which options keep the player alive.
export function dangerOf(t) {
  const list = Array.isArray(t?.candidates) ? t.candidates.filter((c) => c && typeof c.id === 'string' && c.numbers && typeof c.numbers.est_damage_next_3s === 'number') : [];
  if (!list.length) return {};
  const safest = list.reduce((a, c) => (c.numbers.est_damage_next_3s < a.numbers.est_damage_next_3s ? c : a));
  const now = list.find((c) => typeof c.numbers.danger_now === 'string');
  return {
    danger: {
      ...(now ? { now: now.numbers.danger_now } : {}),
      tactics_that_survive_next_3s: list.filter((c) => c.numbers.survives_next_3s === true).map((c) => c.id),
      lowest_damage_tactic: safest.id,
    },
  };
}

// "Ascuas (lv 3/5, evolves into Llamarada at max level, needs stat card Potencia: not taken yet)"
export function moveLine(m) {
  const lv = `lv ${m?.lv ?? '?'}${typeof m?.maxLv === 'number' ? `/${m.maxLv}` : ''}`;
  const e = m?.evo;
  const evo = m?.evolved ? ', already evolved'
    : e && e.into ? `, evolves into ${e.into} at max level, needs stat card ${e.needs ?? '?'}: ${e.ready ? 'already taken' : 'not taken yet'}` : '';
  return `${m?.name ?? m?.id} (${lv}${evo})`;
}

// Move slots as the page reports them (player.slots); only well-formed ones.
export function slotsOf(p) {
  const list = Array.isArray(p?.slots) ? p.slots : [];
  return list.filter((g) => g && Number.isInteger(g.index) && Array.isArray(g.moves) && g.moves.length);
}

// "Ascuas (fire, projectile, range 300, cooldown 0.8 s, lv 2)"
export function moveText(m) {
  const bits = [m?.type, m?.kind,
    typeof m?.range === 'number' ? `range ${m.range}px` : null,
    typeof m?.radius === 'number' ? `radius ${m.radius}px` : null,
    typeof m?.cd === 'number' ? `cooldown ${m.cd}s` : null,
    m?.lv != null ? `lv ${m.lv}` : null].filter(Boolean);
  return `${m?.name ?? m?.id ?? '?'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

export const cardText = (c) => {
  const extra = [c.tag && `tag: ${c.tag}`, c.type && `type: ${c.type}`, c.key && `key: ${c.key}`].filter(Boolean).join(', ');
  return `${c.title ?? ''} — ${c.desc ?? ''}${extra ? ` (${extra})` : ''}`;
};

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

export const cardsOf = (choice) => (Array.isArray(choice?.cards) ? choice.cards.filter((c) => c && Number.isInteger(c.index)) : []);

// Rerolling is only possible on level-up screens with rerolls left.
export const canReroll = (choice) => choice?.kind === 'levelup' && (choice.rerolls ?? 0) > 0;

// Which move slot should be active? Only worth asking with 2+ slots that can be changed.
export function canSwitchSlot(state) {
  const p = state?.player;
  return !!p && !p.locked && slotsOf(p).length >= 2;
}

export function slotQuestion(state) {
  const criteria = {};
  // Daño por segundo al grupo de alrededor que calcula la página (js/agent/tactics.js, stats.dps_slotN).
  const stats = state?.player?.stats || {};
  for (const g of slotsOf(state?.player)) {
    const dps = stats['dps_slot' + (g.index + 1)];
    criteria[String(g.index)] = g.moves.map(moveText).join(' + ') + (typeof dps === 'number' ? ` (estimated ${Math.round(dps)} damage/s to the nearby enemies)` : '');
  }
  return {
    type: 'choice',
    instructions: 'Only the moves in the ACTIVE slot are cast (automatically); the player can switch slots at any time. ' +
      'Which slot should be active right now to deal the most damage and stay safe, given the enemies\' types (type matchups: e.g. water beats fire, ' +
      'electric beats water, fire beats grass/bug/ice) and distances in `state`, and each move\'s type, attack shape and range? ' +
      'Each option is a slot number; its description lists the move(s) in that slot (names in Spanish) and, when known, the damage per second ' +
      'the game computes for it against the enemies around the player (hits counted from each move\'s real shape and range, burn and poison included).',
    criteria,
  };
}

/** Strategy questions: the autopilot mode, plus the active slot when `state` has 2+ switchable slots. */
export function strategyQuestions(state) {
  return {
    ...(canSwitchSlot(state) ? { which_slot: slotQuestion(state) } : {}),
    mode: {
      type: 'choice',
      instructions: 'The character moves by an autopilot while attacks are automatic. Which autopilot mode best keeps the player alive and gaining power right now, given HP, nearby enemies, bosses and XP pickups in `state`?',
      criteria: { ...STRATEGY_MODES },
    },
  };
}

// Jev's answer to buildChoiceQuestions -> {cid, probabilities, choice, confidence, model, reroll_probability?}
export function parseChoiceAnswer(res, choice, withReroll) {
  const cards = cardsOf(choice);
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
  return out;
}

// Jev's answer to strategyQuestions -> {mode, probabilities, confidence, model}
export function parseStrategyAnswer(res) {
  const a = res.answers?.mode;
  if (!a || !(a.choice in STRATEGY_MODES)) throw new JevError('Jev returned no usable strategy answer', 'bad_response');
  const probabilities = {};
  for (const m of Object.keys(STRATEGY_MODES)) probabilities[m] = r2(Number(a.probabilities?.[m]) || 0);
  const out = { mode: a.choice, probabilities, confidence: r2(a.confidence), model: res.model };
  const w = res.answers?.which_slot;
  if (w && typeof w.probabilities === 'object') {
    const sp = {};
    for (const [k, v] of Object.entries(w.probabilities)) if (/^\d+$/.test(k)) sp[k] = r2(Number(v) || 0);
    let slot = Number(w.choice);
    if (!Number.isInteger(slot) || !(String(slot) in sp)) {
      const best = Object.entries(sp).sort((x, y) => y[1] - x[1])[0];
      slot = best ? Number(best[0]) : null;
    }
    if (slot != null) Object.assign(out, { slot, slot_probabilities: sp, slot_confidence: r2(w.confidence) });
  }
  return out;
}

// ---------------- tactics (js/agent/tactics.js on the page) ----------------
// The page computes facts from the real game rules and turns them into 3-6 concrete tactics with
// numbers (which slot, how far from which enemy, where the gap is, the trap...). Jev picks one; the
// page's autopilot carries it out frame by frame. The rules below are a faithful summary of the
// game code (js/systems/combat.js, js/data/types.js, js/entities/enemy.js, js/systems/interact.js).
export const GAME_RULES = [
  'Real-time survivor game. Only the moves in the ACTIVE slot attack, automatically, at the nearest enemy in range; switching slots clears orbit orbs and is limited to once every 8 s.',
  'Damage = move power x attack x type multiplier (super effective x1.6, not very effective x0.6, immune x0.3; dual types multiply, capped 0.3-2.4) x weather.',
  'Enemies hurt on contact (their damage at most every 0.55 s); shooters keep their distance and fire 190 px/s shots that walls block. HP does not regenerate by itself.',
  'Most enemies are slower than the player and can be kited; enemies that "outrun you" (runners) cannot be escaped and must be killed while fleeing in a straight line.',
  'Running a large circle (circle_kite) keeps the slow horde trailing inside the circle within attack range. XP gems never expire and are only picked up within about 78 px, so gems left behind are worth going back for when no chaser is near.',
  'Melee/aura/orbit moves need enemies close; projectiles/beams work at range. Contact damage is 25% lower with a melee move active.',
  'Traps hit every enemy within 74 px when a ground enemy steps on them (explosive is strongest); they also hurt the player within 52 px.',
  'Healing springs restore 14% max HP per second while standing on them. Killing enemies drops XP gems; level-ups give new moves.',
  'After any hit the player is invulnerable for 0.45 s, so contacts and shots land at most once per 0.45 s; floor warnings (circles, beams, bomber fuses) ignore that and stack.',
  'Every 38-56 s a tide (surge) of enemies arrives from one side; enemies left far behind reappear ahead. A crowd can take all HP in under 1 s.',
  'Rare targets: a treasure thief (no damage, flees, escapes after 15 s) drops coins or a x10 ticket; a shiny (2x HP, 5x XP) joins the collection when killed and never leaves; during golden hour golden enemies give 2x XP; a lost pokemon must be escorted to its marker (heals 50% HP).',
].join(' ');

export const TACTIC_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;

/** Well-formed tactic candidates from the page state (state.tactics.candidates). */
export function tacticsOf(state) {
  const list = Array.isArray(state?.tactics?.candidates) ? state.tactics.candidates : [];
  return list.filter((t) => t && typeof t.id === 'string' && TACTIC_ID_RE.test(t.id) && typeof t.label === 'string').slice(0, 6);
}

/** "label | dps_vs_nearby=52, type_multiplier=1.6, ..." */
export function tacticText(t) {
  const nums = t.numbers && typeof t.numbers === 'object'
    ? Object.entries(t.numbers).map(([k, v]) => `${k}=${typeof v === 'number' ? r2(v) : v}`).join(', ')
    : '';
  return nums ? `${t.label} | ${nums}` : t.label;
}

export function tacticQuestions(state) {
  const criteria = {};
  for (const t of tacticsOf(state)) criteria[t.id] = tacticText(t);
  return {
    tactic: {
      type: 'choice',
      instructions: `Game rules: ${GAME_RULES} The autopilot moves the character and executes the chosen tactic frame by frame ` +
        '(it always dodges shots and floor warnings by itself, and it breaks out on its own when staying would be lethal within 2 s). ' +
        'Each option lists est_damage_next_3s and survives_next_3s (simulated from the real damage rules along that option\'s path) and danger_now (HP, damage if standing still, crowd size and its change). ' +
        'Decide in this order: 1) never pick an option with survives_next_3s=false while another has true; ' +
        '2) if HP is below 35% or danger_now says KO, pick heal, evade or the option with the lowest est_damage_next_3s; ' +
        '3) among safe options (est_damage_next_3s below half of HP), prefer killing enemies that outrun the player, a fight whose group_seconds_to_clear is short and est_damage_while_clearing is well below HP, ' +
        'breaking out before being surrounded, and the slot with the highest damage against the enemies around; ' +
        '4) otherwise collect XP. Rare targets (thief, shiny, golden, lost, rift) are worth it only when their own numbers say they fit the time limit ' +
        '(can_catch_in_time, seconds_to_kill vs seconds left, est_seconds_to_kill vs arena_time_limit_s and legend_hits_to_ko_you) and est_damage_next_3s stays below half of HP. ' +
        'Map tactics (rift, altar, bigchest, break, loot, cover) trade time and exposure for power or rewards: take them when their numbers say the danger is low ' +
        '(a lost rift fight only costs time; cover only helps against shooters and not against flying ones for long).',
      criteria,
    },
  };
}

// Jev's answer to tacticQuestions -> {tactic, probabilities, confidence, model, label}
export function parseTacticAnswer(res, state) {
  const list = tacticsOf(state);
  const a = res.answers?.tactic;
  if (!a || typeof a.probabilities !== 'object' || !list.length) throw new JevError('Jev returned no usable tactic answer', 'bad_response');
  const probabilities = {};
  for (const t of list) probabilities[t.id] = r2(Number(a.probabilities[t.id]) || 0);
  let pick = typeof a.choice === 'string' && a.choice in probabilities ? a.choice : null;
  if (!pick) pick = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0][0];
  const t = list.find((x) => x.id === pick);
  return { tactic: pick, label: t.label, probabilities, confidence: r2(a.confidence), model: res.model };
}
