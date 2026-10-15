/* ============ autopilot.js — piloto automático para la IA (js/agent/bridge.js) ============
 * Campo de potencial: los enemigos empujan, la experiencia y los objetos tiran,
 * el jefe tira o empuja según el modo y el centro del mapa tira un poco.
 * Cada fotograma el resultado se manda como eje externo (G.Input.setExternal):
 * si el jugador toca el teclado o la pantalla, manda el jugador.
 * Una orden `move` de la IA lo sustituye durante unos milisegundos.
 */
G.Autopilot = (() => {
  const MODES = ['off', 'kite', 'retreat', 'collect_xp', 'hunt_boss'];
  // Pesos por modo: enemy (empuje), xp (tirón de lo que se recoge), boss (+ empuja, - tira), center.
  const PRESET = {
    off:        { enemy: 0,   xp: 0,   boss: 0,    center: 0 },
    kite:       { enemy: 1,   xp: 0.6, boss: 1.6,  center: 0.05 },
    retreat:    { enemy: 1.6, xp: 0.1, boss: 2.2,  center: 0.02 },
    collect_xp: { enemy: 0.8, xp: 1.6, boss: 1.4,  center: 0.05 },
    hunt_boss:  { enemy: 0.8, xp: 0.3, boss: -1.2, center: 0.02 }
  };
  const PICK_R = 420, BOSS_KEEP = 150;
  let mode = 'off', custom = {}, weights = { ...PRESET.off };
  let over = null;                 // { v:[dx,dy], until } orden move en curso
  let raf = 0;

  function set(m, w) {
    if (!MODES.includes(m)) throw new Error('modo desconocido: ' + m);
    mode = m;
    custom = {};
    if (w && typeof w === 'object') for (const k of ['enemy', 'xp', 'boss', 'center']) {
      if (typeof w[k] === 'number' && isFinite(w[k])) custom[k] = Math.max(-5, Math.min(5, w[k]));
    }
    weights = { ...PRESET[mode], ...custom };
    kick();
  }

  /** Orden `move`: (dx, dy) normalizado durante ms; luego vuelve el piloto (o nada). */
  function move(dx, dy, ms) {
    const v = G.U.norm(dx, dy);
    over = { v, until: performance.now() + ms };
    G.Input.setExternal(v[0], v[1]);
    kick();
  }

  function release() { over = null; mode = 'off'; custom = {}; weights = { ...PRESET.off }; G.Input.clearExternal(); }

  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  function tick() {
    raf = 0;
    const now = performance.now();
    if (over && now >= over.until) over = null;
    if (over) G.Input.setExternal(over.v[0], over.v[1]);
    else if (mode !== 'off' && G.Game.state === 'playing' && G.Game.player && !G.Game.player.dead) {
      const v = field(G.Game.player);
      G.Input.setExternal(v[0], v[1]);
    } else G.Input.clearExternal();
    if (over || mode !== 'off') raf = requestAnimationFrame(tick);
  }

  /**
   * Dirección para el jugador. El campo de potencial se evalúa en 16 direcciones
   * (y quedarse quieto) mirando un poco hacia delante: así se sale por los huecos
   * del cerco en vez de quedarse parado donde las fuerzas se anulan.
   */
  const DIRS = Array.from({ length: 16 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]).concat([[0, 0]]);
  let prev = [0, 0];
  function field(pl) {
    const w = weights;
    const near = [], picks = [];
    for (const e of G.EnemyMgr.all()) {
      if (e.dead) continue;
      const d2 = (e.x - pl.x) ** 2 + (e.y - pl.y) ** 2;
      if (d2 < (e.boss ? 700 : 380) ** 2) near.push(e);
    }
    const hpFrac = pl.hp / pl.maxHp;
    for (const p of G.Pickups.all()) {
      if ((p.x - pl.x) ** 2 + (p.y - pl.y) ** 2 > PICK_R * PICK_R) continue;
      const val = p.kind === 'xpBig' ? 2.5 : p.kind === 'xp' ? 1 : p.kind === 'heal' ? (hpFrac < 0.75 ? 8 * (1 - hpFrac) : 0)
        : p.kind === 'item' || p.kind === 'ticket' || p.kind === 'ticket10' ? 3 : p.kind === 'magnet' ? 3 : 1.2;
      if (val) picks.push([p.x, p.y, val]);
    }
    const hz = G.Hazards ? G.Hazards.all : [];
    // Disparos enemigos: se esquiva donde estarán (no donde están).
    const shots = G.Projectiles.all().filter(s => !s.friendly && !s.dead && (s.x - pl.x) ** 2 + (s.y - pl.y) ** 2 < 360 * 360);
    const free = (x, y) => G.World.isFree(x, y, Math.max(8, pl.r * 0.8), !(G.World.liquidEffect(pl.mon.types) || {}).dmg);
    const L = Math.max(30, pl.spd * 0.45);
    // Hacia dónde queda el grueso de la horda (para no dejarse acorralar).
    let cx = 0, cy = 0;
    for (const e of near) { const d = Math.hypot(e.x - pl.x, e.y - pl.y) || 1; cx += (e.x - pl.x) / d / (1 + d / 150); cy += (e.y - pl.y) / d / (1 + d / 150); }
    const [ax, ay] = G.U.norm(-cx, -cy), crowd = Math.min(1, Math.hypot(cx, cy) / 4);
    const slowLiquid = !G.World.liquidEffect(pl.mon.types).dmg;
    // Para hacer daño hay que estar a tiro: se busca tener al enemigo más cercano a ~3/4 del alcance
    // del ataque activo (menos cuanta menos vida queda; en retreat, nada).
    const m = pl.activeMove && pl.activeMove();
    const reach = Math.max(50, Math.min(300, !m ? 120 : m.kind === 'projectile' || m.kind === 'beam' ? 260 : m.radius || 120));
    const eng = ({ kite: 0.9, collect_xp: 0.5, hunt_boss: 0.4 }[mode] || 0) * (hpFrac > 0.5 ? 1 : hpFrac > 0.3 ? 0.5 : 0.1);
    let best = null, bestS = Infinity;
    for (const [dx, dy] of DIRS) {
      let sc = 0;
      // Paredes, árboles, lava: penalizan (no se descartan, para no quedarse clavado en una esquina).
      if (dx || dy) {
        if (!free(pl.x + dx * 12, pl.y + dy * 12)) sc += 4;
        else if (!free(pl.x + dx * L * 0.5, pl.y + dy * L * 0.5)) sc += 1.5;
        else if (!free(pl.x + dx * L, pl.y + dy * L)) sc += 0.5;
      }
      for (const k of [1, 2]) {
        const qx = pl.x + dx * L * k, qy = pl.y + dy * L * k, kw = k === 1 ? 0.6 : 0.4;
        let danger = 0, gain = 0;
        for (const e of near) {
          const d = Math.max(1, Math.hypot(e.x - qx, e.y - qy) - (e.r || 10) - pl.r);
          if (e.boss) {
            if (w.boss >= 0) danger += w.boss * 3 * Math.exp(-d / 90);
            else gain += -w.boss * 2 * Math.exp(-Math.abs(d - BOSS_KEEP) / 120) - 3 * Math.exp(-d / 40);
          } else danger += w.enemy * Math.exp(-d / (e.spd > pl.spd ? 55 : 38));
        }
        if (eng && k === 1) {
          let dn = Infinity;
          for (const e of near) if (!e.boss) dn = Math.min(dn, Math.hypot(e.x - qx, e.y - qy) - (e.r || 10));
          if (dn < Infinity) gain += w.enemy * eng * (Math.exp(-Math.abs(dn - reach * 0.75) / 35) + 0.4 * Math.exp(-Math.abs(dn - reach * 0.75) / 150)) / 0.6;
        }
        for (const h of hz) if (G.Hazards.inside(h, qx, qy, pl.r + 10)) danger += 6;
        const t = L * k / Math.max(40, pl.spd);
        for (const s of shots) {
          const d = Math.max(1, Math.hypot(s.x + (s.vx || 0) * t - qx, s.y + (s.vy || 0) * t - qy) - (s.r || 7) - pl.r);
          danger += w.enemy * 2.5 * Math.exp(-d / 22);
        }
        for (const [ox, oy, val] of picks) gain += w.xp * val * 0.25 * Math.exp(-Math.hypot(ox - qx, oy - qy) / 110);
        gain -= w.center * Math.hypot(qx, qy) / 1500;
        if (w.boss >= 0) gain += w.enemy * 0.35 * crowd * (dx * ax + dy * ay);
        if (slowLiquid && near.length && G.World.isLiquid(qx, qy)) danger += 0.8;   // el agua frena
        sc += kw * (danger - gain);
      }
      // Un poco de inercia: no cambiar de rumbo por nada (evita temblores).
      sc += 0.08 * (1 - (dx * prev[0] + dy * prev[1]));
      if (sc < bestS) { bestS = sc; best = [dx, dy]; }
    }
    prev = best || [0, 0];
    return prev;
  }

  return {
    MODES, set, move, release,
    get mode() { return mode; },
    get weights() { return { ...weights }; },
    get moving() { return !!over; }
  };
})();
