import { z } from 'zod';
import { ok, guard } from './result.js';

export function register(server, ctx) {
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('get_state', {
    title: 'Get battle state',
    description:
      'Latest snapshot of the paired game (refreshed by the page about every 250 ms while playing), or null if the page has not sent one yet. ' +
      'Fields: phase ("menu" | "playing" | "levelup" | "choice" | "paused" | "held" | "over"), time (seconds survived), ai (0/1/2), ' +
      'player {x, y, hp, maxHp, level, xp, xpNext, kills, moves[{id,name,lv}], active (index of the active slot), slots[{index, active, moves[{id,name,lv,type,kind,range?,radius?,cd}]}], locked (Choice Band: cannot switch), item, stats (also dps_slot1, dps_slot2...: damage per second of each slot against the nearby enemies, from the moves\' real shapes)}, ' +
      'enemies (up to 40 nearest, sorted by distance; dx/dy are relative to the player, +x right, +y down; boss=true for bosses; flying=true: ignores walls and liquid; types = Pokémon types), ' +
      'pickups (nearest, relative dx/dy, kind such as XP gems), autopilot {mode, weights}, ' +
      'tactics {plan (id the autopilot follows now), candidates[{id, kind, label, score, numbers}]} (3-6 tactics computed from the real game rules; see suggest_tactic). ' +
      'map: what is around you on the (infinite, procedurally generated) map — ' +
      'biome (name; it changes every 4 minutes), liquid {kind (water|lava|swamp|poison|spark|ice), slow (speed multiplier while inside, 1 = none), hurts (true: it damages you, do not walk in), slide (true: ice, you slide and steer badly)} — these depend on your own types (e.g. a Fire Pokémon is immune to lava), tile (32 px), ' +
      'grid: 25 strings, one per tile row from north to south, 12 tiles each side of you (~384 px): "@" you, "." floor, "#" rock wall (blocks walking and shots), "~" liquid, ' +
      '"T" tree (blocks, unbreakable cover), "o" rock or chest (blocks, breakable: drops loot), "B" locked big chest (stand next to it ~3.5 s to open), "A" power altar (touch: temporary power, once), ' +
      '"S" spring (heals while you stand on it, runs dry and refills), "x" trap (triggers when stepped on, also hurts enemies), \'"\' tall grass (does not block). ' +
      'props: up to 30 nearest scenery objects within 640 px [{type, dx, dy, dist, solid, breakable, hp?, trap? (poison|sticky|explosive), charge? (spring 0-1), used? (altar), open? (seconds spent opening a big chest)}]. ' +
      'hazards: floor warnings of enemy attacks within 700 px that have not hit yet, soonest first [{kind ("zone" circle with r | "beam" line from dx/dy with angle (rad), len, w), dx, dy, in (seconds until it hits), inside (true: you are in it now, move out)}]. ' +
      'shots: up to 20 nearest enemy projectiles [{dx, dy, vx, vy (px/s), r}]. ' +
      'rift? {dx, dy, ttl (s)}: an open rift leading to a legendary fight; arena? {dx, dy (centre), r (px), type}: you are inside a closed round arena (rift or Judgment); event? (current event id). ' +
      'Enemies with flying=true (hovering Pokémon and all bosses) pass over walls, trees and liquid, so cover does not stop them; you cannot. ' +
      'The game runs in real time, so the snapshot is already slightly old when you read it. phase "over" means the run ended.',
    annotations: ro,
  }, guard(async () => {
    const game = ctx.requireGame();
    return ok(game.state ?? null);
  }));

  server.registerTool('get_choice', {
    title: 'Get the open choice screen',
    description:
      'The choice screen currently open (level-up cards, item or bond pick), or null if none. While it is open the game is paused and waits for a pick. ' +
      'Shape: {cid (id of this screen, grows with every new screen), kind ("levelup" | "item" | "bond"), mode?, step?, rerolls (remaining), ' +
      'cards[{index, key?, type? ("new" | "up" | "evo" | "stat" ...), title, desc, tag?}]}. Card texts are in Spanish. ' +
      'Seeing a choice here marks it as seen, so a later wait_for_choice waits for the next screen.',
    annotations: ro,
  }, guard(async () => {
    const game = ctx.requireGame();
    if (game.choice) ctx.markSeen(game.choice.cid);
    return ok(game.choice ?? null);
  }));

  server.registerTool('wait_for_choice', {
    title: 'Wait for the next choice screen',
    description:
      'Blocks until a choice screen newer than the last one this session has seen appears, then returns it (same shape as get_choice). ' +
      'Returns null on timeout. If a new screen is already open it returns immediately. ' +
      'This is the main loop of play: wait_for_choice -> read cards -> choose(index) -> wait_for_choice again. ' +
      'On null, call get_state: phase "over" means the run ended; otherwise just wait again.',
    inputSchema: {
      timeout_s: z.number().min(0).optional().describe('Seconds to wait, default 30, capped at 60.'),
    },
    annotations: ro,
  }, guard(async ({ timeout_s }, extra) => {
    const game = ctx.requireGame();
    const secs = Math.min(60, Math.max(0, timeout_s ?? 30));
    const choice = await ctx.games.waitForChoice(game, ctx.session.id, ctx.session.lastSeenCid, secs * 1000, extra?.signal);
    if (choice) ctx.markSeen(choice.cid);
    return ok(choice ?? null);
  }));
}
