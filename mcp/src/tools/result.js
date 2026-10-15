// Tool results are JSON text. Errors are returned as isError results so the
// model sees the message and can recover.
export class ToolError extends Error {}

export const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null) }] });
export const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

// Wraps a tool handler: ToolError -> isError result; anything else is logged
// by the caller and returned as a generic error.
export const guard = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    if (e instanceof ToolError || e?.name === 'GameError') return fail(e.message);
    throw e;
  }
};
