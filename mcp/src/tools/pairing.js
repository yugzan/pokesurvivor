import { z } from 'zod';
import { ok, fail, guard } from './result.js';

export function register(server, ctx) {
  server.registerTool('pair', {
    title: 'Pair with a game',
    description:
      'Connect this agent session to one running PokéSurvivor game. The human player opens the game in a browser, ' +
      'enables "AI connection" in the settings and reads you a 6-character pairing code (letters and digits, e.g. "K7QM3X"). ' +
      'Codes are valid for 10 minutes and can be used only once. Call this first: every other tool fails with ' +
      '"not paired" until pairing succeeds. Pairing again with a new code switches this session to that game and ' +
      'releases the previous one. Too many wrong codes block pairing from your address for one minute.',
    inputSchema: {
      code: z.string().min(1).max(32).describe('The 6-character code shown on the player\'s screen (case-insensitive).'),
      client_name: z.string().max(60).optional().describe('Optional name shown to the player, e.g. "Claude".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ code, client_name }, extra) => {
    const ip = ctx.clientIp(extra);
    const wait = ctx.pairBlockedFor(ip);
    if (wait > 0) return fail(`too many wrong pairing codes from your address; try again in ${Math.ceil(wait / 1000)} s`);
    const name = (client_name || ctx.clientInfoName() || 'agent').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || 'agent';
    const previous = ctx.currentGame();
    const game = ctx.games.pair(code, ctx.session.id, name);
    if (!game) {
      ctx.recordPairFailure(ip);
      return fail('invalid or expired pairing code. Ask the player for the current code (6 characters, valid 10 minutes, single use; a used code cannot pair again).');
    }
    if (previous && previous !== game) ctx.games.unpair(previous, ctx.session.id, 'repaired');
    ctx.session.sid = game.sid;
    ctx.session.lastSeenCid = null;
    return ok({
      paired: true,
      page_connected: !!game.sse,
      phase: game.state?.phase ?? null,
      choice_on_screen: !!game.choice,
      next: 'Call get_state to see the battle, set_autopilot to handle movement, then loop wait_for_choice -> choose.',
    });
  }));
}
