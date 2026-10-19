/* ============ input.js — teclado y ratón (el táctil está en touch.js y el mando en gamepad.js) ============ */
G.Input = (() => {
  const down = new Set();
  const pressed = new Set();   // se limpia cada frame
  let mx = 0, my = 0, mdown = false;
  let ext = null;              // eje externo (IA: js/agent/); manda si no tocas teclado ni pantalla

  const MOVE_KEYS = {
    up: ['keyw', 'arrowup'], down: ['keys', 'arrowdown'],
    left: ['keya', 'arrowleft'], right: ['keyd', 'arrowright']
  };

  function code(e) { return (e.code || e.key).toLowerCase(); }

  addEventListener('keydown', e => {
    const c = code(e);
    if (!down.has(c)) pressed.add(c);
    down.add(c);
    // Evita que el navegador haga scroll con flechas/espacio durante el juego.
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'space', 'tab'].includes(c)) e.preventDefault();
  });
  addEventListener('keyup', e => down.delete(code(e)));
  addEventListener('blur', () => { down.clear(); });
  let movedAt = 0;               // última vez que se movió el ratón (apuntado a mano)
  addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; movedAt = performance.now(); });
  addEventListener('mousedown', () => mdown = true);
  addEventListener('mouseup', () => mdown = false);

  return {
    /** Vector de movimiento del jugador (teclado, joystick táctil o mando). */
    axis() {
      const t = G.Touch && G.Touch.vector();
      if (t && (t[0] || t[1])) return t;
      const g = G.Pad && G.Pad.vector();
      if (g && (g[0] || g[1])) return g;
      let x = 0, y = 0;
      if (MOVE_KEYS.left.some(k => down.has(k))) x -= 1;
      if (MOVE_KEYS.right.some(k => down.has(k))) x += 1;
      if (MOVE_KEYS.up.some(k => down.has(k))) y -= 1;
      if (MOVE_KEYS.down.some(k => down.has(k))) y += 1;
      return x || y || !ext ? G.U.norm(x, y) : ext;
    },
    setExternal(dx, dy) { const m = Math.hypot(dx, dy); ext = m > 1e-6 ? (m > 1 ? [dx / m, dy / m] : [dx, dy]) : null; },
    clearExternal() { ext = null; },
    held(c) { return down.has(c); },
    /** true sólo en el frame en que se pulsó. */
    tap(c) { return pressed.has(c); },
    /** Una pulsación que no viene del teclado (el mando): cuenta como tecla en este fotograma. */
    virtual(c) { pressed.add(c); },
    mouse() { return { x: mx, y: my, down: mdown }; },
    /** Cuándo se movió el ratón por última vez (performance.now). */
    get mouseMovedAt() { return movedAt; },
    /** Dónde apunta el ratón en el mundo (el lienzo ocupa toda la ventana). */
    mouseWorld() { return { x: G.Camera.left() + mx / G.Camera.scale, y: G.Camera.top() + my / G.Camera.scale }; },
    endFrame() { pressed.clear(); }
  };
})();
