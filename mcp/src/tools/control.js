import { z } from 'zod';
import { ok, fail, guard } from './result.js';

const MODES = ['off', 'kite', 'retreat', 'collect_xp', 'hunt_boss'];

export function register(server, ctx) {
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // Relays a command and turns the page's answer into a tool result.
  const run = async (op, args, onOk) => {
    const res = await ctx.sendCmd(op, args);
    if (!res.ok) return fail(`${op} failed: ${res.error}`);
    onOk?.();
    return ok({ ok: true, ...(res.data && Object.keys(res.data).length ? { data: res.data } : {}) });
  };

  server.registerTool('choose', {
    title: 'Pick a card',
    description:
      'Pick card number `index` (0-based, the card\'s "index" field) on the open choice screen, exactly as if the player clicked it. ' +
      'The current screen id (cid) is attached automatically; if the screen changed meanwhile the game answers "stale choice" and you should ' +
      'call get_choice again. The game resumes right after the pick. Then call wait_for_choice for the next screen.',
    inputSchema: { index: z.number().int().min(0).describe('0-based card index from the choice\'s cards[].index.') },
    annotations: act,
  }, guard(async ({ index }) => {
    const game = ctx.requireGame();
    const choice = game.choice;
    if (!choice) return fail('no choice screen is open right now; call wait_for_choice first');
    if (Array.isArray(choice.cards) && !choice.cards.some((c) => c?.index === index)) {
      return fail(`no card with index ${index}; valid: ${choice.cards.map((c) => c?.index).join(', ')}`);
    }
    return run('choose', { index, cid: choice.cid }, () => ctx.markSeen(choice.cid));
  }));

  server.registerTool('reroll', {
    title: 'Reroll the cards',
    description:
      'Replace the cards of the open level-up screen with new ones. Only works on "levelup" screens while choice.rerolls > 0; otherwise it fails. ' +
      'Afterwards call get_choice to read the new cards.',
    annotations: act,
  }, guard(async () => {
    const game = ctx.requireGame();
    const choice = game.choice;
    if (!choice) return fail('no choice screen is open right now');
    return run('reroll', { cid: choice.cid });
  }));

  server.registerTool('move', {
    title: 'Steer for a moment',
    description:
      'Short manual steering override: push the stick in direction (dx, dy) for `ms` milliseconds (50..3000), then it returns to neutral. ' +
      'Screen coordinates: +dx is right, +dy is down; the vector is normalized by the game. It temporarily overrides the autopilot, which takes over again afterwards. ' +
      'Because every tool call takes hundreds of milliseconds and the game is real-time, prefer set_autopilot for continuous movement and use move only for a deliberate dodge or reposition.',
    inputSchema: {
      dx: z.number().min(-1).max(1).describe('Horizontal component, -1 (left) .. 1 (right).'),
      dy: z.number().min(-1).max(1).describe('Vertical component, -1 (up) .. 1 (down).'),
      ms: z.number().int().min(50).max(3000).describe('Duration in milliseconds, 50..3000.'),
    },
    annotations: act,
  }, guard(async ({ dx, dy, ms }) => {
    ctx.requireGame();
    return run('move', { dx, dy, ms });
  }));

  server.registerTool('set_autopilot', {
    title: 'Set movement autopilot',
    description:
      'Let the game\'s built-in autopilot move the character continuously (the recommended way to handle movement; attacks are automatic in this survivor-like). ' +
      'Modes: "kite" keeps distance from enemies while circling; "retreat" runs away from the nearest threats; "collect_xp" goes for XP pickups; ' +
      '"hunt_boss" approaches the boss; "off" stops autopilot (the human player keeps control). ' +
      'Optional weights tune the steering (relative numbers): enemy (avoid enemies), xp (attraction to pickups), boss (attraction to the boss), center (stay near the map center). ' +
      'Switch modes as the situation changes, e.g. collect_xp when few enemies are close, retreat when hp is low.',
    inputSchema: {
      mode: z.enum(MODES).describe('Autopilot strategy.'),
      weights: z.object({
        enemy: z.number().optional(),
        xp: z.number().optional(),
        boss: z.number().optional(),
        center: z.number().optional(),
      }).optional().describe('Optional steering weights.'),
    },
    annotations: act,
  }, guard(async ({ mode, weights }) => {
    ctx.requireGame();
    return run('autopilot', weights ? { mode, weights } : { mode });
  }));

  server.registerTool('set_active_move', {
    title: 'Switch the active move',
    description:
      'Only the moves in the ACTIVE slot are cast (automatically); this switches it, like the player pressing 1, 2, 3... ' +
      '`slot` is the 0-based index from get_state player.slots[] (each slot lists its moves with type, kind such as projectile/beam/melee, range or radius, and cooldown; ' +
      'a bond groups several moves in one slot). Pick the slot whose moves fit the enemies (type matchups, distance). ' +
      'Fails while the player holds the Choice Band (player.locked = true), outside a run, or for a slot that does not exist.',
    inputSchema: { slot: z.number().int().min(0).max(11).describe('0-based slot index from get_state player.slots[].index.') },
    annotations: act,
  }, guard(async ({ slot }) => {
    ctx.requireGame();
    return run('active', { slot });
  }));

  server.registerTool('release', {
    title: 'Hand control back',
    description:
      'Stop all AI movement: the manual override returns to neutral and the autopilot is turned off, so the human player has full control again. ' +
      'The pairing stays active (you can still read the state or pick cards).',
    annotations: act,
  }, guard(async () => {
    ctx.requireGame();
    ctx.emit?.('release');                       // stops auto_play (agent-jev)
    return run('release', {});
  }));
}
