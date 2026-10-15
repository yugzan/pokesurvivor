// Event log only: what happened, never request bodies, headers, codes or keys.
export function log(event, fields = {}) {
  if (process.env.LOG_SILENT === '1') return;
  const line = { t: new Date().toISOString(), event };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v;
  console.log(JSON.stringify(line));
}
// Short, non-reversible handle for an id in logs (never the full secret sid).
export const short = (id) => (id ? String(id).slice(0, 6) : undefined);
