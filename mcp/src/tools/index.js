// Tool registry. Every module exports register(server, ctx).
// To add tools (e.g. the agent-jev Jev tools): create src/tools/<name>.js with
// `export function register(server, ctx) { server.registerTool(...) }` and add it here.
import * as pairing from './pairing.js';
import * as read from './read.js';
import * as control from './control.js';
import * as jev from './jev.js';

export const toolModules = [pairing, read, control, jev];

export function registerTools(server, ctx, modules = toolModules) {
  for (const m of modules) m.register(server, ctx);
}
