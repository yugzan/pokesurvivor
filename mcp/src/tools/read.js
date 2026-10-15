import { z } from 'zod';
import { ok, guard } from './result.js';

export function register(server, ctx) {
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('get_state', {
    title: 'Get battle state',
    description:
      'Latest snapshot of the paired game (refreshed by the page about every 250 ms while playing), or null if the page has not sent one yet. ' +
      'Fields: phase ("menu" | "playing" | "levelup" | "choice" | "paused" | "held" | "over"), time (seconds survived), ai (0/1/2), ' +
      'player {x, y, hp, maxHp, level, xp, xpNext, kills, moves[{id,name,lv}], item, stats}, ' +
      'enemies (up to 40 nearest, sorted by distance; dx/dy are relative to the player, +x right, +y down; boss=true for bosses), ' +
      'pickups (nearest, relative dx/dy, kind such as XP gems), autopilot {mode, weights}. ' +
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
