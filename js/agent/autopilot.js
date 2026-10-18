/* ============ autopilot.js — piloto automático para la IA (js/agent/bridge.js) ============
 * Ejecuta una TÁCTICA (js/agent/tactics.js): pelear con un hueco a cierta distancia de un
 * enemigo, salir del cerco por un hueco, recoger gemas, curarse, cebar una trampa...
 * La táctica la elige Jev (useTactic) o, si no hay respuesta, la mejor candidata.
 * Los modos de siempre (kite, retreat, collect_xp, hunt_boss) siguen valiendo: deciden
 * qué tácticas se prefieren cuando nadie elige.
 *
 * Cada fotograma se prueban 16 direcciones (y quedarse quieto) SIMULANDO 1,2 s:
 * dónde estarás tú (con paredes) y dónde estarán los enemigos que te persiguen, sus
 * disparos y los avisos del suelo. Se elige la que cumple la táctica sin que te toquen.
 * El resultado se manda como eje externo (G.Input.setExternal): si el jugador toca el
 * teclado o la pantalla, manda el jugador. Una orden `move` lo sustituye unos milisegundos.
 * El hueco activo lo cambia la táctica, con un mínimo de 8 s entre cambios (cambiar borra
 * los orbes); si el jugador (o un agente) cambia de hueco a mano, se respeta 20 s.
 */
G.Autopilot = (() => {
  const MODES = ['off', 'kite', 'retreat', 'collect_xp', 'hunt_boss'];
  // Pesos por modo: enemy (miedo a los enemigos), xp (gemas), boss (+ se aleja, - va a por él), center.
  const PRESET = {
    off:        { enemy: 0,   xp: 0,   boss: 0,    center: 0 },
    kite:       { enemy: 1,   xp: 0.6, boss: 1.6,  center: 0.05 },
    retreat:    { enemy: 1.6, xp: 0.1, boss: 2.2,  center: 0.02 },
    collect_xp: { enemy: 0.8, xp: 1.6, boss: 1.4,  center: 0.05 },
    hunt_boss:  { enemy: 0.8, xp: 0.3, boss: -1.2, center: 0.02 }
  };
  // Qué tácticas prefiere cada modo cuando no elige Jev (se suma a su puntuación).
  const MODE_BIAS = {
    kite: {},
    // (Las de objetos del mapa también son 'goto': su sesgo va por id; el 'goto' de retreat es curarse.)
    retreat: { evade: 0.4, goto: 0.2, fight: -0.15, lure: 0.1, cover: 0.3, rift: -0.2, altar: 0, bigchest: -0.2, break: -0.2, loot: -0.1 },
    collect_xp: { collect: 0.35, loot: 0.3, break: 0.1 },
    hunt_boss: { boss: 0.5 }
  };
  const SLOT_DWELL = 8000, MANUAL_HOLD = 20000, PLAN_EVERY = 250, JEV_TTL = 3000;
  let mode = 'off', custom = {}, weights = { ...PRESET.off };
  let over = null;                 // { v:[dx,dy], until } orden move en curso
  let raf = 0;
  let picked = null;               // { id, until, source } táctica elegida desde fuera (Jev, agente)
  let plan = null, planAt = 0, cands = [], facts = null, factsT = 0;
  let slotAt = 0, mySlot = -1, mySig = '', myPl = null, manualUntil = 0;
  let lastLog = '';

  function set(m, w) {
    if (!MODES.includes(m)) throw new Error('modo desconocido: ' + m);
    mode = m;
    custom = {};
    if (w && typeof w === 'object') for (const k of ['enemy', 'xp', 'boss', 'center']) {
      if (typeof w[k] === 'number' && isFinite(w[k])) custom[k] = Math.max(-5, Math.min(5, w[k]));
    }
    weights = { ...PRESET[mode], ...custom };
    planAt = 0;
    kick();
  }

  /** Orden `move`: (dx, dy) normalizado durante ms; luego vuelve el piloto (o nada). */
  function move(dx, dy, ms) {
    const v = G.U.norm(dx, dy);
    over = { v, until: performance.now() + ms };
    G.Input.setExternal(v[0], v[1]);
    kick();
  }

  /** Táctica elegida desde fuera (id de G.Tactics.candidates), durante ms. */
  function useTactic(id, ms = JEV_TTL, source = 'jev') {
    if (typeof id !== 'string' || !id) return false;
    picked = { id, until: performance.now() + Math.max(500, Math.min(15000, ms)), source };
    planAt = 0;
    return true;
  }

  /** El jugador o un agente ha elegido hueco a mano: no se toca durante un rato. */
  function holdSlot(ms = MANUAL_HOLD) { manualUntil = performance.now() + ms; }

  function release() { over = null; picked = null; plan = null; reflex.on = false; mode = 'off'; custom = {}; weights = { ...PRESET.off }; G.Input.clearExternal(); }

  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  function tick() {
    raf = 0;
    const now = performance.now();
    if (over && now >= over.until) over = null;
    const pl = G.Game.player;
    if (over) G.Input.setExternal(over.v[0], over.v[1]);
    else if (mode !== 'off' && G.Game.state === 'playing' && pl && !pl.dead) {
      try {
        if (now - planAt >= PLAN_EVERY) { planAt = now; replan(pl, now); }
        const v = steer(pl, plan);
        G.Input.setExternal(v[0], v[1]);
      } catch (e) {
        if (lastLog !== String(e)) { lastLog = String(e); console.warn('[Autopilot]', e); }
        G.Input.clearExternal();
      }
    } else G.Input.clearExternal();
    if (over || mode !== 'off') raf = requestAnimationFrame(tick);
  }

  // ---------------- elegir táctica y hueco ----------------

  function replan(pl, now) {
    facts = G.Tactics.facts(pl); factsT = performance.now();
    cands = G.Tactics.candidates(pl, facts);
    let c = null;
    if (picked && now < picked.until) c = cands.find(x => x.id === picked.id) || null;
    else picked = null;
    if (!c) {
      const bias = MODE_BIAS[mode] || {};
      const sc = x => x.score + (bias[x.boss ? 'boss' : x.id in bias ? x.id : x.kind] || 0) + (plan && plan.id === x.id && !plan.reflex ? 0.12 : 0);   // un poco de constancia
      c = cands.slice().sort((a, b) => sc(b) - sc(a))[0] || null;
    }
    c = reflexCheck(pl, now, c) || c;
    plan = c;
    if (c && Number.isInteger(c.slot)) chooseSlot(pl, c.slot, now, !!c.needSlot);
    let tg = null;
    if (c && c.targetId != null) tg = G.EnemyMgr.all().find(e => e.id === c.targetId && !e.dead) || null;
    routePlan(pl, c, tg);
  }

  // ---------------- reflejo: salir sin esperar a Jev ----------------
  // Jev contesta cada 1,5 s y a veces se muere antes (vida 56 -> 0 en menos de 1 s). Con la simulación de
  // tactics.js (addDanger: daño de los próximos 2-3 s siguiendo cada táctica):
  //   entra sólo si la táctica elegida (la de Jev o, sin Jev, la mejor) te deja KO en 2 s, o llega una marea
  //   (surge) y esa táctica te quita al menos el 75 % de la vida en 2 s. Umbral sin datos concluyentes: una
  //   prueba (2×8 partidas sin Jev) dio mejor el 50 %, pero no se reprodujo; otra de 16+16 con las mismas semillas
  //   dio mediana 119 s con 75 % y 100,5 s con 50 % (no significativo, desviación ~25 s). Se queda el 75 % porque
  //   quita el control a Jev la mitad de veces (casi nunca con la vida llena); y además la salida más segura (safest)
  //   es claramente mejor: ahorra al menos un 25 % de la vida en 2 s y no cuesta más en 3 s. Quedarse quieto
  //   ya no cuenta para entrar (en 6 partidas eso disparaba el reflejo con la vida llena y una táctica segura).
  //   Mientras dura, no se usa lo que elija Jev (se guarda). Sale cuando lleva al menos 1,2 s y durante 0,75 s
  //   seguidos la táctica elegida cuesta < 80 % de la vida y no se cumple lo de la marea; luego 1 s sin volver
  //   a entrar salvo que la táctica elegida te deje KO. Las órdenes `move`, el teclado/pantalla del jugador y el
  //   hueco fijado a mano mandan igual que siempre (el reflejo sólo cambia la táctica y no cambia de hueco).
  //   Cada partida nueva empieza con el reflejo apagado y la cuenta a cero.
  const RX_MIN = 1200, RX_CALM = 750, RX_EXIT = 0.8, RX_COOL = 1000, RX_GAIN = 0.25, RX_SURGE = 0.75;
  const reflex = { on: false, since: 0, calmSince: 0, exitAt: -1e9, count: 0, reason: '', id: null, log: [], pl: null };
  let spikeN = 0, lastPlanHalf = false, lastSurge = false;

  function reflexCheck(pl, now, c) {
    if (reflex.pl !== pl) Object.assign(reflex, { on: false, since: 0, calmSince: 0, exitAt: -1e9, count: 0, reason: '', id: null, log: [], pl });
    const D = facts && G.Tactics.dangerOf(pl, facts);
    if (!D) return null;
    const hp = Math.max(1, pl.hp);
    if (c && !c.danger) G.Tactics.addDanger(pl, facts, c);
    const plan2 = c && c.danger ? c.danger.dmg2 : D.stay.dmg2;
    const surgeHit = D.surge && plan2 >= hp * RX_SURGE;
    // Subidas bruscas de peligro: Jev pregunta en el acto (jev.js).
    const half = plan2 >= hp * 0.5;
    if ((half && !lastPlanHalf) || (D.surge && !lastSurge)) spikeN++;
    lastPlanHalf = half; lastSurge = D.surge;
    if (!reflex.on) {
      const lethal = plan2 >= hp;
      if (!(lethal || surgeHit)) return null;
      // Recién devuelto el mando a Jev, 1 s sin volver a entrar salvo que su táctica misma te deje KO.
      if (now - reflex.exitAt < RX_COOL && !lethal) return null;
      const esc = safest(pl, c);
      if (!esc || (c && esc.id === c.id)) return null;
      if (esc.danger.dmg2 > plan2 - hp * RX_GAIN || (c && c.danger && esc.danger.dmg > c.danger.dmg)) return null;
      reflex.on = true; reflex.since = now; reflex.calmSince = 0; reflex.count++;
      reflex.reason = (lethal ? `KO in 2 s (plan ${c ? c.id : '-'} ${plan2}, HP ${Math.round(pl.hp)})`
        : `surge (${D.n150} within 150 px, ${D.d150_1 >= 0 ? '+' : ''}${D.d150_1} in 1 s; ${D.n300} within 300 px, ${D.d300_2 >= 0 ? '+' : ''}${D.d300_2} in 2 s; plan ${c ? c.id : '-'} ${plan2}, HP ${Math.round(pl.hp)})`) +
        ` -> ${esc.id} (${esc.danger.dmg2} in 2 s)`;
      reflex.log.push({ t: D.t, on: true, reason: reflex.reason, plan: c ? c.id : null, hp: Math.round(pl.hp), maxHp: Math.round(pl.maxHp) });
      if (reflex.log.length > 50) reflex.log.shift();
      spikeN++;
      reflex.id = esc.id;
      return { ...esc, slot: undefined, reflex: true };
    }
    // Calma: la táctica elegida ya no te deja KO (cuesta < 80 % de la vida) y no hay marea que la haga peligrosa.
    const calm = plan2 < hp * RX_EXIT && !surgeHit;
    if (!calm) reflex.calmSince = 0;
    else if (!reflex.calmSince) reflex.calmSince = now;
    if (calm && now - reflex.since >= RX_MIN && now - reflex.calmSince >= RX_CALM) {
      reflex.on = false; reflex.exitAt = now;
      reflex.log.push({ t: D.t, on: false, plan: c ? c.id : null });
      if (reflex.log.length > 50) reflex.log.shift();
      return null;                                                          // vuelve lo que elija Jev
    }
    // Se sigue con la misma salida mientras otra no ahorre al menos el 15 % de la vida (que no cambie a cada paso).
    let esc = safest(pl, null);
    const cur = cands.find(x => x.id === reflex.id);
    if (cur && cur.danger && esc.id !== cur.id && esc.danger.dmg > cur.danger.dmg - hp * 0.15) esc = cur;
    reflex.id = esc.id;
    return { ...esc, slot: undefined, reflex: true };
  }

  /**
   * La salida más segura: salir por el hueco (aunque no esté entre las candidatas) o la candidata de
   * movimiento que menos daño te hace en 3 s (vuelta grande, curarse, cubrirse, la grieta...); a igualdad,
   * salir por el hueco. No cuentan las peleas (quedarse a pelear es lo que se quiere evitar).
   * (En las pruebas del 16-10-2026 salir por el hueco a ciegas costó 83 cuando la vuelta grande costaba 38.)
   */
  function safest(pl, c) {
    let esc = cands.find(x => x.id === 'evade');
    if (!esc) { esc = G.Tactics.escapeCandidate(pl, facts); G.Tactics.addDanger(pl, facts, esc); }
    let best = esc;
    for (const x of cands) if (x.kind !== 'fight' && x.danger && x.danger.dmg < best.danger.dmg) best = x;
    return best;
  }

  function chooseSlot(pl, want, now, force = false) {
    // ¿Lo ha cambiado otro? (Aprender un movimiento o fusionar también lo cambia: eso no cuenta.)
    const sig = pl.slots.map(g => g.length).join(',');
    if (mySlot >= 0 && pl.active !== mySlot && sig === mySig && pl === myPl) holdSlot();
    mySlot = pl.active; mySig = sig; myPl = pl;
    if (want === pl.active || !pl.slots[want] || now < manualUntil) return;
    if (pl.hasItem('choiceband') && pl.slots[pl.active]) return;
    const cur = facts && facts.slots[pl.active];
    // force: el hueco activo no sirve para esta táctica (p. ej. Cadena no le da a una roca).
    const curUseless = force || !cur || cur.baseDps <= 0;
    // Un hueco que no hace daño (Danza Espada, Agilidad...) se deja enseguida; si no, 8 s mínimo.
    if (!curUseless && now - slotAt < SLOT_DWELL) return;
    const nw = facts && facts.slots[want];
    if (!curUseless && nw && cur && nw.dps < cur.dps * (cur.orbit ? 1.5 : 1.2)) return;
    pl.setActive(want);
    slotAt = now; mySlot = pl.active;
  }

  // ---------------- ejecutar: simulación de 16 direcciones ----------------

  const DIRS = Array.from({ length: 16 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]).concat([[0, 0]]);
  const STEPS = [0.25, 0.5, 0.8, 1.2, 1.8], SW = [1, 0.9, 0.6, 0.35, 0.25];
  const KEEPERS = ['ranged', 'fan', 'beamer', 'zoner', 'healer', 'summoner'];
  const FIGHT = { kind: 'fight' };
  let prev = [0, 0], lastDbg = null;
  let wander = Math.random() * 6.28;

  function steer(pl, c) {
    const w = weights;
    const evading = !!c && c.kind === 'evade';
    const fear = Math.max(0.2, w.enemy) * (evading ? 1.4 : 1);
    const all = G.EnemyMgr.all();
    const near = [];
    for (const e of all) {
      if (e.dead || e.behavior === 'thief') continue;
      const d = Math.hypot(e.x - pl.x, e.y - pl.y);
      if (d < 520) near.push(e);
    }
    const spd = Math.max(30, pl.spd);
    const wSlow = (G.World.liquidEffect(pl.mon.types) || {}).slow || 1;
    const dry = pl.inLiquid && wSlow < 1 ? spd / wSlow : spd;
    const wSlowE = (G.World.liquidEffect([]) || {}).slow || 1;      // a un enemigo que no es de tipo agua
    const hpFrac = pl.hp / pl.maxHp;
    const hpScale = 1 / Math.max(0.25, hpFrac);           // con poca vida, más prudente
    const rFree = Math.max(8, pl.r * 0.8);
    const liquidOk = !(G.World.liquidEffect(pl.mon.types) || {}).dmg;
    const free = (x, y) => G.World.isFree(x, y, rFree, liquidOk);
    const shots = G.Projectiles.all().filter(s => !s.friendly && !s.dead && (s.x - pl.x) ** 2 + (s.y - pl.y) ** 2 < 420 * 420);
    // Hasta dónde llega cada disparo antes de chocar con una pared o un objeto sólido (combat.js resolve):
    // detrás de un árbol no hace falta esquivar.
    const stopT = new Map();
    for (const s of shots) {
      let st = 9;
      if (s.vx || s.vy) for (let t = 0.05; t <= STEPS[2] + 0.01; t += 0.05) if (G.World.projectileBlock(s.x + (s.vx || 0) * t, s.y + (s.vy || 0) * t, s.r || 7)) { st = t; break; }
      stopT.set(s, st);
    }
    const hz = G.Hazards ? G.Hazards.all.filter(h => !h.hit) : [];
    const traps = facts ? facts.traps : [];
    const m = pl.activeMove && pl.activeMove();
    const melee = !!m && (m.kind === 'melee' || m.kind === 'dash');
    const ready = !m || m.kind === 'orbit' || m.t <= 0.15;
    // Objetivo de la táctica.
    let target = null;
    if (c && c.targetId != null) target = all.find(e => e.id === c.targetId && !e.dead) || null;
    if (c && c.kind === 'fight' && !target && facts) {
      const t = G.Tactics.targetFor(facts, facts.slots[pl.active]);
      target = t && t.e;
    }
    let keep = c && c.keep ? c.keep : 200;
    // Al que no se le deja atrás (corredor) no se le espera a 200 px: se huye en línea recta
    // disparándole (a esa velocidad apenas acorta) hasta tumbarlo.
    const ranged = !!m && m.kind !== 'orbit' && m.kind !== 'aura' && !melee && G.Tactics.hitRange(m) > 250;
    // Un corredor cerca manda sobre la táctica (también al huir): o lo tumbas mientras huyes en línea
    // recta, o te alcanza.
    if (ranged) {
      let rn = null, rd = 430;
      for (const e of near) {
        if (e.boss || KEEPERS.includes(e.behavior) || e.spd * (1 - (e.slow || 0)) < dry * 0.85) continue;
        const d = Math.hypot(e.x - pl.x, e.y - pl.y);
        if (d < rd) { rd = d; rn = e; }
      }
      // (En la vuelta grande sólo si ya está encima: la vuelta no se abandona por uno que viene de lejos.)
      if (rn && !(c && c.kind === 'circle' && rd > 230)) target = rn;
    }
    const chaseTarget = !!target && ranged && !target.boss && target.spd * (1 - (target.slow || 0)) >= dry * 0.85;
    if (chaseTarget) keep = Math.min(460, G.Tactics.hitRange(m) * 0.85);
    if (melee && target) keep = ready ? Math.max(20, (m.radius || 40) * 0.6) : (m.radius || 40) + 55;   // golpear y apartarse
    // (Salir del cerco: el rumbo lo da sobre todo la simulación y la horda por cada lado; el hueco sólo orienta.)
    // (c.commit: la grieta saca de allí a todos los enemigos al entrar, así que se va a por ella aunque estén cerca.)
    // (c.chase: el duende del tesoro huye y se va a los 15 s: acercarse pesa más que guardar las distancias.)
    const goalW = !c ? 0 : c.kind === 'evade' ? 0.35 : c.chase ? 2.2 : c.kind === 'fight' ? (melee ? 1.4 : 1.0) : c.kind === 'goto' ? (c.commit ? 3.5 : 1.4) : 1.1;

    // El camino (routePlan) manda salvo al golpear cuerpo a cuerpo y al perseguir al corredor.
    // Cerca de un objetivo del mapa (c.within: grieta, altar, cofre, roca, botín, cobertura) se va
    // directo y se queda: el camino evita las casillas a <0,45 s y no deja pararse en el sitio.
    // (Sólo si se llega en línea recta: si hay una roca o una pared en medio, manda el camino.)
    const holdGoal = !!c && c.kind === 'goto' && c.within != null && Math.hypot(c.goal[0] - pl.x, c.goal[1] - pl.y) < Math.max(90, c.within + 40)
      && straightTo(pl, c.goal, c.within, free);
    const useWay = !!way && !(melee && target && ready) && !chaseTarget && !(c && c.kind === 'circle') && !holdGoal;
    const circleGoal = c && c.kind === 'circle' ? circlePoint(pl, c) : null;
    // Peso de la horda: crece con cuántos hay en 400 px.
    let n400 = 0, crowdHere = 0;
    for (const e of near) {
      const d = Math.hypot(e.x - pl.x, e.y - pl.y);
      if (d < 400 && !KEEPERS.includes(e.behavior)) n400++;
      crowdHere += Math.exp(-d / 95);
    }
    const crowdW = fear * (0.04 + Math.min(0.16, n400 * 0.008)) * (evading ? 2 : 1);
    let best = null, bestS = Infinity;
    const dbg = window.__apDebug ? (lastDbg = []) : null;
    for (const [dx, dy] of DIRS) {
      // Tu camino, con paredes: si algo te para, te quedas ahí.
      const P = [];
      let px = pl.x, py = pl.y, blockedAt = -1, lastT = 0, stopped = false;
      for (let k = 0; k < STEPS.length; k++) {
        // El agua frena (×0,6; pantano ×0,45; los de tipo agua no): cuenta dónde pisas en cada tramo.
        const t = STEPS[k], step = (wSlow < 1 && G.World.isLiquid(px, py) ? dry * wSlow : dry) * (t - lastT); lastT = t;
        if (!stopped && (dx || dy)) {
          const nx = px + dx * step, ny = py + dy * step;
          if (free(nx, ny) && free((px + nx) / 2, (py + ny) / 2)) { px = nx; py = ny; }
          else {
            stopped = true;
            // Al lado de un objetivo sólido (altar, cofre) un paso entero choca: se cuenta el medio paso, sin castigo.
            const f = holdGoal ? [0.5, 0.25].find(q => free(px + dx * step * q, py + dy * step * q)) : null;
            if (f) { px += dx * step * f; py += dy * step * f; } else blockedAt = k;
          }
        }
        P.push([px, py]);
      }
      let sc = 0;
      if (blockedAt === 0) sc += 3; else if (blockedAt > 0) sc += 0.6 / blockedAt;

      // Enemigos: te persiguen (los que disparan se quedan a su distancia).
      for (const e of near) {
        const keeper = KEEPERS.includes(e.behavior) && !e.boss;
        const wet = !e.flying && wSlowE < 1 && G.World.isLiquid(e.x, e.y) && !(e.types || []).includes('water');
        const es = e.spd * (1 - (e.slow || 0)) * (e.phase === 'dash' ? 3.4 : e.behavior === 'charger' ? 1.4 : 1) * (wet ? 0.55 : 1);
        const thr = Math.min(3, Math.max(0.4, e.dmg / Math.max(8, pl.hp) * 5)) * (e.boss ? 1.6 : 1) * (melee && e === target && ready ? 0.35 : 1);
        const fuse = e.behavior === 'bomber' && e.phase === 'fuse';
        for (let k = 0; k < STEPS.length; k++) {
          const t = STEPS[k], [qx, qy] = P[k];
          let ex = e.x, ey = e.y;
          if (e.phase === 'dash' && e.dx != null) { const tt = Math.min(t, Math.max(0, e.pt || 0)); ex += e.dx * es * tt; ey += e.dy * es * tt; }
          else if (e.behavior === 'charger' && e.phase === 'aim') {
            // Apunta a donde estás AHORA y embiste a ×3,4 durante 0,42 s (enemy.js).
            const tt = Math.min(0.42, Math.max(0, t - Math.max(0, e.pt || 0)));
            const [ux, uy] = G.U.norm(pl.x - e.x, pl.y - e.y);
            ex += ux * e.spd * 3.4 * tt; ey += uy * e.spd * 3.4 * tt;
          }
          else if (!keeper && !fuse) {
            // Sin pararse en el contacto: cuánto "se te mete" dice cuánto antes y más rato te pega.
            const ddx = qx - ex, ddy = qy - ey, dd = Math.hypot(ddx, ddy) || 1;
            const mv = Math.min(es * t, dd + 40);
            ex += ddx / dd * mv; ey += ddy / dd * mv;
            if (mv >= dd) { ex = qx - ddx / dd * (mv - dd); ey = qy - ddy / dd * (mv - dd); }
          }
          let clr = Math.hypot(qx - ex, qy - ey) - (e.r || 10) - pl.r - (fuse ? 62 : keeper ? 30 : 0);
          if (!keeper && !fuse && e.phase !== 'dash') {
            const dd = Math.hypot(qx - e.x, qy - e.y);
            clr = dd - es * t - (e.r || 10) - pl.r;          // negativo = te alcanza (y cuánto antes)
          }
          sc += SW[k] * thr * fear * hpScale * (clr <= 3 ? 4 + Math.min(4, -clr / 15) : 1.6 * Math.exp(-clr / 26));
        }
      }
      // Que no te dejen sin salida: cuánta horda hay por ese lado (rayo de 360 px) y si se puede pasar.
      if (dx || dy) {
        let dens = 0, wall = 0;
        for (let k = 1; k <= 3; k++) {
          const rx = pl.x + dx * 120 * k, ry = pl.y + dy * 120 * k;
          if (!wall && !free(rx, ry)) wall = k;
          for (const e of near) if (!KEEPERS.includes(e.behavior) || e.boss) dens += Math.exp(-Math.hypot(e.x - rx, e.y - ry) / 95) / k;
        }
        sc += crowdW * dens + (wall ? 0.5 * crowdW * (4 - wall) : 0);
      } else sc += crowdW * crowdHere;
      // Disparos enemigos: dónde estarán.
      for (const s of shots) {
        for (let k = 0; k < 3; k++) {
          const t = STEPS[k], [qx, qy] = P[k];
          if (t > stopT.get(s)) break;
          const clr = Math.hypot(s.x + (s.vx || 0) * t - qx, s.y + (s.vy || 0) * t - qy) - (s.r || 7) - pl.r;
          sc += SW[k] * 2.2 * hpScale * Math.min(2, (s.dmg || 10) / Math.max(8, pl.hp) * 5) * (clr <= 2 ? 3 : Math.exp(-clr / 14));
        }
      }
      // Avisos en el suelo: dónde estarás cuando estallen.
      for (const h of hz) {
        const left = Math.max(0, h.delay - h.t);
        if (left > 1.5) continue;
        let k = STEPS.findIndex(t => t >= left); if (k < 0) k = STEPS.length - 1;
        const [qx, qy] = left < 0.12 ? [pl.x + dx * spd * left, pl.y + dy * spd * left] : P[k];
        if (G.Hazards.inside(h, qx, qy, pl.r + 8)) sc += 6 * hpScale * Math.min(2, (h.pct ? 0.3 * pl.maxHp : h.dmg) / Math.max(8, pl.hp) * 3 + 0.5);
      }
      // Trampas: no pisarlas (saltan a 13 px y te hacen daño a <52 px).
      for (const tr of traps) {
        for (let k = 0; k < 2; k++) {
          const d = Math.hypot(P[k][0] - tr.x, P[k][1] - tr.y);
          if (d < 22) sc += 5; else if (d < 56 && (tr.kind !== 'sticky')) sc += 0.6;
        }
      }
      // El agua frena (a ti y a ellos): sólo si hay enemigos cerca.
      if (wSlow < 1 && near.length && G.World.isLiquid(P[1][0], P[1][1])) sc += 0.8;

      // Lo que pide la táctica.
      if (circleGoal && !chaseTarget) {
        const d0 = Math.hypot(circleGoal[0] - pl.x, circleGoal[1] - pl.y), d1 = Math.hypot(circleGoal[0] - P[1][0], circleGoal[1] - P[1][1]);
        sc += 1.3 * (d1 - d0) / (spd * STEPS[1]) + (!dx && !dy ? 0.5 : 0);
      } else if (useWay) {
        const d0 = Math.hypot(way.x - pl.x, way.y - pl.y), d1 = Math.hypot(way.x - P[1][0], way.y - P[1][1]);
        sc += 1.2 * (d0 < 12 ? (dx || dy ? 0.3 : -0.3) : (d1 - d0) / (spd * STEPS[1]));
      } else if (chaseTarget) sc += 1.0 * goalCost(pl, FIGHT, target, keep, P, dx, dy, spd);
      else sc += goalW * goalCost(pl, c, target, keep, P, dx, dy, spd);
      // Al corredor sólo se le dispara si es el más cercano (el blanco automático es el más cercano):
      // alejarse de los demás más que de él.
      if (chaseTarget) {
        const [qx, qy] = P[2];
        const dt = Math.hypot(target.x - qx, target.y - qy);
        for (const e of near) if (e !== target) {
          const de = Math.hypot(e.x - qx, e.y - qy);
          if (de < dt + 20) sc += 0.25 * Math.min(1.5, (dt + 20 - de) / 80);
        }
      }
      // Gemas de paso (sin desviarse mucho).
      // (Subir de nivel es lo que hace más fuerte: las gemas tiran bastante; el peligro ya lo mide la simulación.)
      if (w.xp > 0 && facts) {
        let gv = 0;
        for (const g of facts.gems) {
          const d0 = Math.hypot(g.x - pl.x, g.y - pl.y), d1 = Math.hypot(g.x - P[2][0], g.y - P[2][1]);
          if (d0 < 300) gv += g.v * (d0 - d1) / (spd * STEPS[2]) / (1 + d0 / 120);
        }
        sc -= w.xp * 0.35 * Math.min(2.5, Math.max(-2.5, gv));
      }
      // Jefe: alejarse o ir a por él según el peso (los modos de siempre).
      if (w.boss < 0) for (const e of near) if (e.boss) {
        const d0 = Math.hypot(e.x - pl.x, e.y - pl.y), d1 = Math.hypot(e.x - P[1][0], e.y - P[1][1]);
        sc += -w.boss * 0.3 * (Math.abs(d1 - 180) - Math.abs(d0 - 180)) / (spd * 0.5);
      }
      sc += w.center * 0.2 * (Math.hypot(P[1][0], P[1][1]) - Math.hypot(pl.x, pl.y)) / 200;
      // Un poco de inercia: no cambiar de rumbo por nada (evita temblores).
      sc += 0.1 * (1 - (dx * prev[0] + dy * prev[1]));
      if (!dx && !dy) sc += 0.05 + (near.some(e => !KEEPERS.includes(e.behavior) && Math.hypot(e.x - pl.x, e.y - pl.y) < (e.spd >= dry * 0.85 ? 420 : 220)) ? 0.6 : 0);
      if (dbg) dbg.push([Math.round(Math.atan2(dy, dx) * 57.3), dx || dy ? 1 : 0, +sc.toFixed(2)]);
      if (sc < bestS) { bestS = sc; best = [dx, dy]; }
    }
    prev = best || [0, 0];
    return prev;
  }

  // ---------------- a dónde ir: quién llega antes a cada casilla ----------------
  // En una rejilla de 29×29 casillas alrededor (las del mapa, 32 px): cuánto tardas TÚ en llegar
  // (andando, rodeando paredes, árboles y charcos que queman; el agua frena) y cuánto tarda el
  // enemigo más rápido en llegar. Margen = lo que les sacas. Se elige la casilla con más margen
  // (y lo que pide la táctica: tener a tiro al blanco, las gemas, el manantial...) y se va por el
  // camino más corto. Así se sale por los huecos del cerco antes de que se cierren y no se mete
  // uno en callejones contra el lago o las rocas.
  const GR = 14, GN = GR * 2 + 1;
  const gDist = new Float32Array(GN * GN), gFrom = new Int32Array(GN * GN), gOpen = new Uint8Array(GN * GN), gEnemy = new Float32Array(GN * GN);
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  let way = null;          // { x, y, margin } siguiente punto del camino

  function routePlan(pl, c, target) {
    const TS = G.World.TS, spd = Math.max(30, G.Tactics.drySpd(pl));
    const ptx = Math.floor(pl.x / TS), pty = Math.floor(pl.y / TS), ox = ptx - GR, oy = pty - GR;
    const water = (G.World.liquidEffect(pl.mon.types) || {}).slow || 1;
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const k = j * GN + i;
      gOpen[k] = G.World.walkable(ox + i, oy + j) ? (G.World.isLiquid((ox + i + 0.5) * TS, (oy + j + 0.5) * TS) ? 2 : 1) : 0;
      gDist[k] = Infinity; gFrom[k] = -1;
    }
    const start = GR * GN + GR;
    gOpen[start] = gOpen[start] || 1;
    gDist[start] = 0;
    // Dijkstra sencillo (rejilla pequeña).
    const heap = [start];
    const push = k => { heap.push(k); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (gDist[heap[p]] <= gDist[heap[i]]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && gDist[heap[l]] < gDist[heap[m]]) m = l; if (r < heap.length && gDist[heap[r]] < gDist[heap[m]]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const done = new Uint8Array(GN * GN);
    while (heap.length) {
      const k = pop();
      if (done[k]) continue;
      done[k] = 1;
      const i = k % GN, j = (k / GN) | 0;
      for (const [a, b, w] of NB) {
        const ni = i + a, nj = j + b;
        if (ni < 0 || nj < 0 || ni >= GN || nj >= GN) continue;
        const nk = nj * GN + ni;
        if (!gOpen[nk]) continue;
        if (a && b && (!gOpen[j * GN + ni] || !gOpen[nj * GN + i])) continue;     // sin cortar esquinas
        const nd = gDist[k] + w * (gOpen[nk] === 2 ? 1 / water : 1);
        if (nd < gDist[nk]) { gDist[nk] = nd; gFrom[nk] = k; push(nk); }
      }
    }
    // Cuándo llega el enemigo más rápido a cada casilla (en línea recta: lo prudente).
    gEnemy.fill(99);
    for (const e of G.EnemyMgr.all()) {
      if (e.dead || e.behavior === 'thief') continue;
      const keeper = KEEPERS.includes(e.behavior) && !e.boss;
      const es = Math.max(20, e.spd * (1 - (e.slow || 0)));
      const ex = e.x / TS - ox - 0.5, ey = e.y / TS - oy - 0.5;
      if (ex < -12 || ey < -12 || ex > GN + 12 || ey > GN + 12) continue;
      const reachPx = (e.r || 10) + pl.r + 6 + (keeper ? 120 : 0);   // a los que disparan, no ponerse delante
      for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
        const d = Math.hypot(i - ex, j - ey) * TS - reachPx;
        const t = Math.max(0, d) / es;
        const k = j * GN + i;
        if (t < gEnemy[k]) gEnemy[k] = t;
      }
    }
    const rng = target && pl.activeMove() ? G.Tactics.hitRange(pl.activeMove()) * 0.8 : 0;
    let best = -1, bs = -Infinity;
    for (let k = 0; k < GN * GN; k++) {
      if (!done[k] || gDist[k] === Infinity) continue;
      const tP = gDist[k] * TS / spd;
      if (tP > 3.2) continue;
      const margin = gEnemy[k] - tP;
      const x = (k % GN + ox + 0.5) * TS, y = (((k / GN) | 0) + oy + 0.5) * TS;
      let v = Math.min(margin, 2.5) * 1.0 - (margin < 0.4 ? 2 : 0) - tP * 0.08;
      // En el agua vas más lento y salir cuesta: no es sitio para quedarse (parece vacío porque nadie aparece ahí).
      if (water < 1 && gOpen[k] === 2) v -= 1.2;
      if (tP < 0.45) v -= 0.4;          // quedarse quieto deja que te rodeen: mejor ir a algún sitio
      if (c) {
        if (c.kind === 'fight' && target) { const d = Math.hypot(target.x - x, target.y - y); v += d < rng ? 0.6 : -Math.min(1, (d - rng) / 300); }
        else if ((c.kind === 'collect' || c.kind === 'goto') && c.goal) v -= Math.hypot(c.goal[0] - x, c.goal[1] - y) / 250;
      }
      // Salidas: que la casilla no sea un callejón.
      let open = 0; const i = k % GN, j = (k / GN) | 0;
      for (const [a, b] of NB) { const ni = i + a, nj = j + b; if (ni >= 0 && nj >= 0 && ni < GN && nj < GN && gOpen[nj * GN + ni]) open++; }
      v -= (8 - open) * 0.06;
      if (v > bs) { bs = v; best = k; }
    }
    if (best < 0) { way = null; return; }
    // Siguiente punto del camino: el primero a más de ~2 casillas (o el destino).
    let k = best, path = [];
    while (k >= 0 && k !== start) { path.push(k); k = gFrom[k]; }
    path.reverse();
    const pick = path[Math.min(path.length - 1, 2)];
    if (pick == null) { way = { x: pl.x, y: pl.y, margin: gEnemy[start], here: true }; return; }
    way = { x: (pick % GN + ox + 0.5) * TS, y: (((pick / GN) | 0) + oy + 0.5) * TS, margin: gEnemy[best] - gDist[best] * TS / spd, dest: [(best % GN + ox + 0.5) * TS, (((best / GN) | 0) + oy + 0.5) * TS] };
  }

  /**
   * Vuelta grande: el punto al que ir. Normalmente uno del círculo ~0,55 rad por delante (así también
   * se vuelve al círculo si te has salido); si hay una gema cerca del recorrido, por delante y sin
   * enemigos encima, se tuerce hacia ella (sin parar ni dar la vuelta).
   */
  let circleGem = null;
  function circlePoint(pl, c) {
    const [ax, ay] = c.anchor, R = c.R, dir = c.dir;
    const th = Math.atan2(pl.y - ay, pl.x - ax);
    let goal = [ax + Math.cos(th + dir * 0.55) * R, ay + Math.sin(th + dir * 0.55) * R];
    let pick = null, pd = Infinity;
    for (const g of (facts ? facts.gems : [])) {
      if (g.d > 300) continue;
      let da = Math.atan2(g.y - ay, g.x - ax) - th;
      da = Math.atan2(Math.sin(da), Math.cos(da)) * dir;            // >0 = por delante
      // Cerca del recorrido y por delante; o muy cerca de ti y no detrás (un pequeño desvío).
      const onPath = Math.abs(Math.hypot(g.x - ax, g.y - ay) - R) <= 120 && da >= -0.05 && da <= 1.3;
      const tx = -Math.sin(th) * dir, ty = Math.cos(th) * dir;        // sentido de la marcha
      const nearAhead = g.d < 170 && ((g.x - pl.x) * tx + (g.y - pl.y) * ty) / (g.d || 1) > -0.1;
      if (!onPath && !nearAhead) continue;
      if (G.EnemyMgr.queryCircle(g.x, g.y, 45).some(e => !e.dead && !KEEPERS.includes(e.behavior))) continue;
      if (g.d < pd) { pd = g.d; pick = g; }
    }
    circleGem = pick;
    if (pick) goal = [pick.x, pick.y];
    return goal;
  }

  /** ¿Se llega andando en línea recta hasta `within` px del objetivo? */
  function straightTo(pl, goal, within, free) {
    const d = Math.hypot(goal[0] - pl.x, goal[1] - pl.y), n = Math.ceil(d / 8);
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      if (d * (1 - k) < within) return true;
      if (!free(pl.x + (goal[0] - pl.x) * k, pl.y + (goal[1] - pl.y) * k)) return false;
    }
    return true;
  }

  /** Coste (negativo = bueno) de cómo deja cada dirección lo que pide la táctica. */
  function goalCost(pl, c, target, keep, P, dx, dy, spd) {
    const [qx, qy] = P[2], span = spd * STEPS[2];
    if (!c) return 0;
    switch (c.kind) {
      case 'fight': {
        if (!target) return 0;
        const d0 = Math.hypot(target.x - pl.x, target.y - pl.y), d1 = Math.hypot(target.x - qx, target.y - qy);
        return (Math.abs(d1 - keep) - Math.abs(d0 - keep)) / span;
      }
      case 'evade': return -(dx * c.dir[0] + dy * c.dir[1]);
      case 'collect': case 'goto': {
        const [gx, gy] = c.goal;
        const d0 = Math.hypot(gx - pl.x, gy - pl.y), d1 = Math.hypot(gx - qx, gy - qy);
        if (c.stay && d0 < 14) return dx || dy ? 0.5 : -0.5;
        if (c.within != null) {
          // Quedarse en la banda [near, within] alrededor del objetivo (cofre: 3,5 s a su lado; roca: a tiro).
          const lo = c.near || 0, hi = c.within;
          const out1 = d1 > hi ? d1 - hi : d1 < lo ? lo - d1 : 0, out0 = d0 > hi ? d0 - hi : d0 < lo ? lo - d0 : 0;
          if (!out0) return out1 ? 0.6 + out1 / span : (dx || dy ? 0.15 : -0.3);
          // Al acercarse cuenta el punto del recorrido más cercano (si no, pasarse de largo en 0,8 s parece alejarse).
          let best = out1;
          for (let k = 0; k < 2; k++) {
            const dk = Math.hypot(gx - P[k][0], gy - P[k][1]);
            best = Math.min(best, dk > hi ? dk - hi : dk < lo ? lo - dk : 0);
          }
          return (best - out0) / span;
        }
        return (d1 - d0) / span;
      }
      case 'lure': {
        // Pasar junto a la trampa (a ~70 px) y seguir: el punto al otro lado.
        const [tx, ty] = c.trap;
        const [ux, uy] = G.U.norm(tx - pl.x, ty - pl.y);
        const side = Math.hypot(tx - pl.x, ty - pl.y) < 90 ? [ux, uy] : [ux * 0.94 - uy * 0.34, uy * 0.94 + ux * 0.34];
        const gx = tx + side[0] * 120, gy = ty + side[1] * 120;
        const d0 = Math.hypot(gx - pl.x, gy - pl.y), d1 = Math.hypot(gx - qx, gy - qy);
        return (d1 - d0) / span;
      }
      case 'roam': {
        wander += (Math.random() - 0.5) * 0.05;
        return -(dx * Math.cos(wander) + dy * Math.sin(wander));
      }
    }
    return 0;
  }

  return {
    MODES, set, move, release, useTactic, holdSlot,
    get mode() { return mode; },
    get weights() { return { ...weights }; },
    get moving() { return !!over; },
    /** Los hechos del último replanteo (G.Tactics.facts) y cuándo (performance.now(), ms). */
    get facts() { return facts; }, get factsAt() { return factsT; },
    /** La táctica en curso y las candidatas (para el estado que ven los agentes). */
    get plan() { return plan; },
    get candidates() { return cands; },
    get debug() { return lastDbg; },
    get way() { return way; },
    /** El hueco lo ha fijado el jugador o un agente: no se cambia hasta que pase (holdSlot). */
    get slotLocked() { return performance.now() < manualUntil; },
    get circleGem() { return circleGem; },
    get picked() { return picked && performance.now() < picked.until ? { ...picked } : null; },
    /** Reflejo (salir sin esperar a Jev): activo, veces, motivo y registro. */
    get reflex() {
      // Partida nueva y aún sin planificar: ya no es la de antes (se pone a cero en el primer replan).
      if (reflex.pl && G.Game.player && G.Game.player !== reflex.pl && G.Game.state !== 'over') return { on: false, count: 0, reason: '', log: [] };
      return { on: reflex.on, count: reflex.count, reason: reflex.reason, log: reflex.log.slice() };
    },
    /** Sube cada vez que el peligro se dispara (jev.js pregunta en el acto). */
    get dangerSpike() { return spikeN; }
  };
})();
