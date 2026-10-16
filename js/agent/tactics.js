/* ============ tactics.js — lo que la IA sabe del juego y las tácticas que puede elegir ============
 * Tres capas (js/agent/):
 *   1. Conocimiento (aquí): con las reglas REALES del juego calcula hechos del momento:
 *      por hueco, el daño por segundo contra los enemigos de alrededor (tabla de tipos,
 *      clima, recarga, alcance), por enemigo su amenaza y lo que cuesta tumbarlo, el
 *      cerco (por dónde se puede salir) y lo que hay en el suelo (trampas, manantiales).
 *   2. Tácticas candidatas (aquí): 3–6 opciones concretas con sus números
 *      ("pelear con el hueco 2 a 200 px del Diglett", "salir por el NE", "recoger 6 gemas"...).
 *      Jev (js/agent/jev.js) elige una; sin Jev, la de más puntuación.
 *   3. Ejecución (autopilot.js): cada fotograma lleva a cabo la táctica elegida
 *      (distancia de combate, esquivar disparos y avisos, paredes, no dejarse rodear).
 *
 * Reglas usadas (archivo:línea en la versión del 2026-10-15):
 *   - sólo ataca el hueco activo; cambiarlo borra los orbes (player.js setActive, combat.js tick)
 *   - alcance para lanzar: combat.js reach(); el cuerpo a cuerpo golpea a radius + radio del enemigo
 *   - daño = dmg · atk · tipos (types.js, ×1.6 / ×0.6 / ×0.3, tope 0.3–2.4) · clima (weather.js)
 *   - contacto: e.dmg cada 0.55 s como mucho (combat.js resolve); con cuerpo a cuerpo activo, −25 %
 *   - disparos enemigos 190 px/s (enemy.js shoot); los que guardan distancia: enemy.js keepsDistance
 *   - trampas: veneno / pegajosa / explosiva en 74 px; saltan al pisarlas un enemigo que no vuela
 *     o tú; a ti te afectan a <52 px (interact.js)
 *   - lava y demás charcos que queman: los enemigos los rodean (pathing.js), no sirven de cebo
 */
G.Tactics = (() => {
  const U = G.U;
  const NEAR = 460;                       // radio de lo que se tiene en cuenta
  const DIR8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const KEEPERS = ['ranged', 'fan', 'beamer', 'zoner', 'healer', 'summoner'];
  const r1 = v => Math.round(v * 10) / 10;

  // ---------------- conocimiento: movimientos ----------------

  /** Distancia a la que el movimiento hace daño (no la de lanzarlo). */
  function hitRange(m) {
    switch (m.kind) {
      case 'melee': return m.radius;                                   // + radio del enemigo
      case 'beam': return m.radius;
      case 'projectile': return Math.min(520, (m.speed || 300) * (m.life || 1.5));
      case 'cone': return (m.speed || 300) * (m.life || 0.4);
      case 'nova': return (m.speed || 220) * (m.life || 1.2);
      case 'boomerang': return m.radius + 40;
      case 'chain': return 280;
      case 'meteor': return 340;
      case 'dash': return m.radius + 60;
      case 'aura': return m.radius;
      case 'orbit': return m.radius + (m.size || 8);
      case 'turret': return m.range || 300;
      case 'mine': case 'trail': return 40;
      default: return 0;                                               // buff
    }
  }

  /** A qué distancia del enemigo conviene estar con este movimiento. */
  function engageDist(m) {
    const h = hitRange(m);
    switch (m.kind) {
      case 'projectile': return U.clamp(h * 0.42, 140, 230);
      case 'beam': return U.clamp(h * 0.7, 90, 220);
      case 'cone': return U.clamp(h * 0.7, 70, 170);
      case 'boomerang': return U.clamp(h * 0.6, 80, 200);
      case 'chain': return 190;
      case 'meteor': return 210;
      case 'nova': return U.clamp(h * 0.45, 70, 160);
      case 'dash': return U.clamp(m.radius * 0.8, 60, 140);
      case 'orbit': return Math.max(36, m.radius * 0.95);
      case 'aura': return Math.max(30, m.radius * 0.6);
      case 'melee': return Math.max(26, m.radius * 0.7);
      case 'turret': return 150;
      case 'mine': case 'trail': return 120;
      default: return 220;
    }
  }

  /** Golpes "equivalentes a uno" por lanzamiento contra un blanco, y si hace daño en área. */
  const SHAPE = {
    projectile: m => [Math.max(1, (m.count | 0) * 0.75), false],
    nova: m => [Math.max(1, (m.count | 0) * 0.22), true],
    cone: m => [Math.max(1, (m.count | 0) * 0.45), true],
    melee: () => [1, true], beam: () => [1, true], aura: () => [1, true],
    boomerang: () => [1.6, true], chain: m => [1 + (m.count | 0) * 0.6, false],
    meteor: m => [Math.max(1, (m.count | 0) * 0.6), true], dash: () => [1, true],
    orbit: m => [Math.max(1, (m.count | 0) * 0.5), true],
    mine: () => [0.6, true], trail: () => [0.6, true], turret: () => [0.7, false],
    buff: () => [0, false]
  };

  /** Tu velocidad fuera del agua (pl.spd ya trae el frenazo si estás dentro). */
  function drySpd(pl) {
    const w = (G.World.liquidEffect(pl.mon.types) || {}).slow || 1;
    return pl.inLiquid && w < 1 ? pl.spd / w : pl.spd;
  }

  const typeK = (type, e) => G.Types.mult(type, e.types) * G.Weather.mult(type);

  /** Daño por segundo de un movimiento contra un enemigo (sin contar el área). */
  function moveDps(pl, m, e) {
    const sh = (SHAPE[m.kind] || SHAPE.buff)(m);
    if (!sh[0] || !m.dmg) return 0;
    const cd = m.kind === 'orbit' ? Math.max(0.12, m.cd) : Math.max(0.12, m.cd * pl.cdMul);
    return (m.dmg * pl.atk * sh[0] / cd) * (e ? typeK(m.type, e) : 1) * (1 + pl.critChance * 0.5);
  }

  // ---------------- conocimiento: enemigos ----------------

  /** Amenaza de un enemigo: daño por segundo que te puede hacer y si lo puedes dejar atrás. */
  function threatOf(pl, e) {
    const tk = G.Types.mult(e.atkType, pl.mon.types);
    const contact = (e.dmg / 0.55) * tk * (1 - pl.reduction);
    const keeper = KEEPERS.includes(e.behavior);
    const shot = e.def && e.def.shotCd ? (e.def.shotDmg || 10) * (e.dmg / (e.def.dmg || e.dmg || 1)) / e.def.shotCd * tk : 0;
    const spd = e.spd * (1 - (e.slow || 0));
    return {
      contact, shot, keeper,
      fast: spd >= drySpd(pl) * 0.85,      // no se le deja atrás corriendo
      dps: keeper ? shot : contact
    };
  }

  // ---------------- hechos del momento ----------------

  function facts(pl) {
    const enemies = [];
    for (const e of G.EnemyMgr.all()) {
      if (e.dead || e.behavior === 'thief') continue;
      const d = Math.hypot(e.x - pl.x, e.y - pl.y);
      if (d > (e.boss ? 800 : NEAR)) continue;
      enemies.push({ e, d, th: threatOf(pl, e) });
    }
    enemies.sort((a, b) => a.d - b.d);

    // Huecos: daño por segundo contra lo que hay cerca (pesado por cercanía).
    const slots = pl.slots.map((g, i) => {
      let dps = 0, wsum = 0, kSum = 0;
      const main = g[0];
      for (const x of enemies) {
        const w = 1 / (1 + x.d / 180);
        let v = 0;
        for (const m of g) v += moveDps(pl, m, x.e);
        dps += v * w; wsum += w; kSum += (main ? typeK(main.type, x.e) : 1) * w;
      }
      let base = 0;
      for (const m of g) base += moveDps(pl, m, null);
      const area = g.some(m => (SHAPE[m.kind] || SHAPE.buff)(m)[1]);
      return {
        index: i, moves: g, main,
        dps: wsum ? dps / wsum : base, baseDps: base, typeK: wsum ? kSum / wsum : 1, area,
        range: main ? hitRange(main) : 0, keep: main ? engageDist(main) : 220,
        melee: g.some(m => m.kind === 'melee' || m.kind === 'aura' || m.kind === 'orbit'),
        orbit: g.some(m => m.kind === 'orbit')
      };
    });

    // Cerco: 16 sectores alrededor, el enemigo más cercano en cada uno.
    const SEC = 16, secMin = new Array(SEC).fill(Infinity);
    for (const x of enemies) {
      if (x.th.keeper || x.d > 320) continue;
      const a = Math.atan2(x.e.y - pl.y, x.e.x - pl.x);
      const s = ((Math.round(a / (Math.PI * 2 / SEC)) % SEC) + SEC) % SEC;
      secMin[s] = Math.min(secMin[s], x.d);
    }
    const blocked = s => secMin[s] < 200;
    const occupied = secMin.filter(v => v < 200).length;
    let gap = null;
    for (let s = 0; s < SEC; s++) {
      const a = s * Math.PI * 2 / SEC, dx = Math.cos(a), dy = Math.sin(a);
      // Hueco = el sector y sus vecinos libres, y suelo transitable hacia allí.
      const clear = Math.min(secMin[s], secMin[(s + 1) % SEC] * 1.3, secMin[(s + SEC - 1) % SEC] * 1.3);
      let walk = 0;
      for (let k = 1; k <= 4; k++) if (G.World.isFree(pl.x + dx * 40 * k, pl.y + dy * 40 * k, Math.max(8, pl.r * 0.8))) walk = k; else break;
      const sc = Math.min(clear, 600) + walk * 40 - (blocked(s) ? 300 : 0);
      if (!gap || sc > gap.score) gap = { s, dir: [dx, dy], clear: Math.min(clear, 999), walk: walk * 40, score: sc };
    }

    // Lo que hay en el suelo.
    const hpFrac = pl.hp / pl.maxHp;
    const gems = [];
    let heal = null;
    for (const p of G.Pickups.all()) {
      const d = Math.hypot(p.x - pl.x, p.y - pl.y);
      if (d > 1100) continue;                // no caducan: también las que quedaron atrás (se vuelve a por ellas)
      if (p.kind === 'heal') { if (!heal || d < heal.d) heal = { x: p.x, y: p.y, d, kind: 'berry' }; continue; }
      const v = p.kind === 'xpBig' ? 3 : p.kind === 'xp' ? 1 : p.kind === 'magnet' || p.kind === 'item' || p.kind === 'ticket' || p.kind === 'ticket10' ? 4 : 0.5;
      gems.push({ x: p.x, y: p.y, d, v });
    }
    const traps = [];
    let spring = null;
    for (const p of G.World.specialsNear(pl.x, pl.y, 420)) {
      const d = Math.hypot(p.x - pl.x, p.y - pl.y);
      if (p.type === 'trap') traps.push({ x: p.x, y: p.y - 8, d, kind: ['poison', 'sticky', 'explosive'][p.kind] || 'trap' });
      else if (p.type === 'spring' && p.charge > 0.25 && (!spring || d < spring.d)) spring = { x: p.x, y: p.y - 8, d, kind: 'spring' };
    }
    const liq = G.World.liquidEffect([]);         // lo que hace el charco de este bioma a quien no es inmune
    return { pl, hpFrac, enemies, slots, occupied, gap, gems, heal, spring, traps, liquid: G.World.liquidKind(), liquidHurts: !!liq.dmg };
  }

  /** Prioridad de un enemigo como blanco: rápido (no se le deja atrás), a distancia, curandero, frágil. */
  function targetFor(F, slot) {
    let best = null, bs = -1;
    for (const x of F.enemies) {
      if (x.e.boss && F.enemies.length > 1 && x.d > 200) continue;
      const dps = slot ? slotDpsVs(F.pl, slot, x.e) : 1;
      if (!dps) continue;
      const ttk = x.e.hp / dps;
      const w = (x.th.keeper ? 1.6 : 1) * (x.e.behavior === 'healer' ? 1.3 : 1) * (x.e.behavior === 'bomber' ? 0.6 : 1);
      // El que no se deja atrás va primero aunque aguante mucho: o lo tumbas o te alcanza.
      const s = x.th.fast && !x.e.boss && x.d < 520 ? 10 / (1 + x.d / 220) : w / (1 + ttk) / (1 + x.d / 220);
      if (s > bs) { bs = s; best = { ...x, ttk }; }
    }
    return best;
  }
  function slotDpsVs(pl, slot, e) { let v = 0; for (const m of slot.moves) v += moveDps(pl, m, e); return v; }

  // ---------------- vuelta grande (circle kite) ----------------
  // La táctica de siempre en un survivor: correr en un círculo grande alrededor de un punto despejado
  // con la horda dentro/detrás. Casi todos son más lentos (enemies.js: 45–80 px/s, tú ~105): se
  // quedan en una cola que persigue por dentro del círculo, a menos del alcance del ataque, y las
  // gemas de los que caen quedan cerca del recorrido de la siguiente vuelta.
  let orb = null;          // { pl, A:[x,y], R, dir, clear, checkT }
  const ORB_PTS = 28;

  /** ¿Se puede correr por todo el círculo? (paredes, árboles, agua, charcos que queman) */
  function circleBlocked(pl, A, R) {
    let bad = 0;
    const r = Math.max(8, pl.r * 0.8), waterOk = !(G.World.liquidEffect(pl.mon.types) || {}).slow;
    for (let i = 0; i < ORB_PTS; i++) {
      const a = i / ORB_PTS * Math.PI * 2, x = A[0] + Math.cos(a) * R, y = A[1] + Math.sin(a) * R;
      if (!G.World.isFree(x, y, r, waterOk && !(G.World.liquidEffect(pl.mon.types) || {}).dmg)) bad++;
    }
    return bad;
  }

  function hordeCenter(pl, F) {
    let x = 0, y = 0, w = 0;
    for (const v of F.enemies) {
      if (v.th.keeper || v.e.boss || v.d > 480) continue;
      const k = 1 / (1 + v.d / 250);
      x += v.e.x * k; y += v.e.y * k; w += k;
    }
    return w ? [x / w, y / w, w] : null;
  }

  /** Mantiene (o elige) el círculo: centro A, radio R, sentido dir (+1 antihorario en pantalla). */
  function orbitPlan(pl, F, R0) {
    const now = performance.now();
    const H = hordeCenter(pl, F);
    if (!orb || orb.pl !== pl || Math.hypot(pl.x - orb.A[0], pl.y - orb.A[1]) > orb.R + 420) orb = null;
    if (orb && now - orb.checkT < 1000) return orb;
    // Opciones de centro: el actual (a la deriva hacia la horda y las gemas lejanas), y puntos a R de ti
    // en 8 direcciones (empezando hacia la horda), con dos radios.
    const opts = [];
    if (orb) {
      const A = orb.A.slice();
      if (H) { A[0] += (H[0] - A[0]) * 0.05; A[1] += (H[1] - A[1]) * 0.05; }
      // Las gemas caen donde muere la horda (dentro de la vuelta o en la cola): se desplaza el centro
      // para que la vuelta PASE por el grupo de gemas más jugoso (a distancia R del centro).
      let gc = null, gbest = 0;
      for (const g of F.gems) {
        let v = 0, gx = 0, gy = 0;
        for (const h of F.gems) if ((h.x - g.x) ** 2 + (h.y - g.y) ** 2 < 110 * 110) { v += h.v; gx += h.x * h.v; gy += h.y * h.v; }
        if (v > gbest) { gbest = v; gc = [gx / v, gy / v]; }
      }
      if (gc && gbest >= 1) {
        const d = Math.hypot(A[0] - gc[0], A[1] - gc[1]) || 1;
        const tx = gc[0] + (A[0] - gc[0]) / d * orb.R, ty = gc[1] + (A[1] - gc[1]) / d * orb.R;
        A[0] += (tx - A[0]) * 0.25; A[1] += (ty - A[1]) * 0.25;
      }
      // Se mantiene la misma vuelta mientras se pueda correr por ella: así se pasa otra vez por donde
      // cayeron las gemas de la vuelta anterior.
      const bad = circleBlocked(pl, A, orb.R);
      if (bad <= 2) { Object.assign(orb, { A, clear: bad <= 1, bad, checkT: now }); return orb; }
      opts.push({ A, R: orb.R, keep: true });
    }
    const base = H ? Math.atan2(H[1] - pl.y, H[0] - pl.x) : Math.random() * 6.28;
    for (const R of [R0, R0 * 0.75]) for (let k = 0; k < 8; k++) {
      const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI / 4;
      opts.push({ A: [pl.x + Math.cos(a) * R, pl.y + Math.sin(a) * R], R, keep: false, k });
    }
    let best = null, bs = -Infinity;
    for (const o of opts) {
      const bad = circleBlocked(pl, o.A, o.R);
      const hd = H ? Math.hypot(H[0] - o.A[0], H[1] - o.A[1]) : 0;
      const sc = -bad * 1.0 - hd / 400 + (o.keep ? 1.2 : 0) - (o.k || 0) * 0.05 + (o.R === R0 ? 0.2 : 0);
      if (sc > bs) { bs = sc; best = { ...o, bad }; }
    }
    const dir = orb && best.keep ? orb.dir : (() => {
      // Sentido: el que aleja de la horda al arrancar (o el de antes).
      const ux = pl.x - best.A[0], uy = pl.y - best.A[1];
      if (!H) return orb ? orb.dir : 1;
      const t1 = [-uy, ux], cross = t1[0] * (H[0] - pl.x) + t1[1] * (H[1] - pl.y);
      return cross > 0 ? -1 : 1;
    })();
    orb = { pl, A: best.A, R: best.R, dir, clear: best.bad <= 1, bad: best.bad, checkT: now };
    return orb;
  }

  // ---------------- tácticas candidatas ----------------

  const dirName = ([dx, dy]) => DIR8[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
  const nameOf = e => (e && (e.name || 'enemy')) + (e && e.types ? ' (' + e.types.join('/') + ')' : '');

  /**
   * 3–6 tácticas con sus números. Cada una: { id, kind, label, score, slot?, keep?, target?, goal?, dir?, numbers }.
   * score: la puntuación del respaldo (sin Jev), 0..1 aprox.
   */
  function candidates(pl, F = facts(pl)) {
    const out = [];
    const near200 = F.enemies.filter(x => x.d < 200 && !x.th.keeper).length;
    const incoming = F.enemies.reduce((a, x) => a + (x.d < 260 ? (x.th.keeper ? x.th.shot : x.th.contact * 0.5) : 0), 0);
    const danger = U.clamp(incoming / Math.max(1, pl.hp) * 2, 0, 3);      // ~ parte de la vida que se pierde por s, ×2
    const hp = F.hpFrac;
    // Calma: nadie que persiga a menos de 300 px (los que disparan no cuentan, se quedan lejos).
    const calm = !F.enemies.some(x => !x.th.keeper && x.d < 300);

    // Pelear: los dos mejores huecos (con daño).
    const ranked = F.slots.filter(s => s.baseDps > 0).sort((a, b) => b.dps - a.dps);
    for (const s of ranked.slice(0, 2)) {
      const tg = targetFor(F, s);
      if (!tg) continue;
      const cur = s.index === pl.active;
      const best = ranked[0];
      let score = 0.55 * (s.dps / Math.max(1, best.dps)) + (cur ? 0.05 : 0) - (s.melee ? 0.12 * Math.min(3, near200) / 3 : 0)
        - (hp < 0.35 ? 0.2 : 0);
      if (tg.th.fast && tg.d < 260) score += 0.15;          // el que no se deja atrás: hay que tumbarlo
      out.push({
        id: 'fight_s' + s.index, kind: 'fight', slot: s.index, keep: s.keep, targetId: tg.e.id,
        label: `Fight with slot ${s.index + 1} (${s.moves.map(m => m.name).join(' + ')}): keep ${Math.round(s.keep)} px from ${nameOf(tg.e)}`,
        score,
        numbers: {
          slot: s.index + 1, active_now: cur, move_kind: s.main.kind, move_type: s.main.type,
          dps_vs_nearby: Math.round(s.dps), type_multiplier: r1(s.typeK), hit_range_px: Math.round(s.range), keep_distance_px: Math.round(s.keep),
          target: nameOf(tg.e), target_distance_px: Math.round(tg.d), target_seconds_to_kill: r1(tg.ttk),
          target_outruns_you: tg.th.fast, target_shoots: tg.th.keeper,
          ...(s.orbit && !cur ? { note: 'switching to it re-creates its orbs' } : {}),
          ...(!cur && pl.slots[pl.active] && pl.slots[pl.active].some(m => m.kind === 'orbit') ? { note: 'switching clears the orbs of the current slot' } : {})
        }
      });
    }

    // Jefe.
    const boss = F.enemies.find(x => x.e.boss);
    if (boss && ranked.length) {
      const s = ranked.slice().sort((a, b) => slotDpsVs(pl, b, boss.e) * (b.melee ? 0.6 : 1) - slotDpsVs(pl, a, boss.e) * (a.melee ? 0.6 : 1))[0];
      const dps = slotDpsVs(pl, s, boss.e), ttk = boss.e.hp / Math.max(1, dps);
      out.push({
        id: 'boss_s' + s.index, kind: 'fight', slot: s.index, keep: Math.max(s.keep, 170), targetId: boss.e.id, boss: true,
        label: `Fight the boss ${nameOf(boss.e)} with slot ${s.index + 1}`,
        score: 0.45 + (hp > 0.6 ? 0.1 : -0.25) - (near200 > 3 ? 0.15 : 0),
        numbers: { slot: s.index + 1, dps_vs_boss: Math.round(dps), type_multiplier: r1(typeK(s.main.type, boss.e)), boss_hp: Math.round(boss.e.hp), seconds_to_kill: Math.round(ttk), boss_distance_px: Math.round(boss.d) }
      });
    }

    // Salir del cerco.
    if (F.gap && (F.occupied >= 4 || near200 >= 3 || hp < 0.5)) {
      out.push({
        id: 'evade', kind: 'evade', dir: F.gap.dir,
        label: `Break out to the ${dirName(F.gap.dir)} gap and regroup`,
        score: 0.2 + 0.08 * F.occupied / 2 + (hp < 0.35 ? 0.35 : 0) + Math.min(0.3, danger * 0.25),
        numbers: { surrounded_sectors_of_16: F.occupied, enemies_within_200px: near200, gap_direction: dirName(F.gap.dir), gap_clearance_px: Math.round(F.gap.clear), hp_percent: Math.round(hp * 100) }
      });
    }

    // Recoger experiencia: el grupo de gemas más jugoso.
    if (F.gems.length) {
      let best = null;
      for (const g of F.gems) {
        let v = 0;
        for (const h of F.gems) if ((h.x - g.x) ** 2 + (h.y - g.y) ** 2 < 90 * 90) v += h.v;
        // Peligro cerca del grupo.
        let risk = 0;
        for (const x of F.enemies) if (!x.th.keeper) risk += Math.exp(-Math.hypot(x.e.x - g.x, x.e.y - g.y) / 70);
        const s = v / (1 + g.d / 350) - risk * 2;
        if (!best || s > best.s) best = { ...g, v, risk, s };
      }
      if (best && best.risk < 3) {
        out.push({
          id: 'collect', kind: 'collect', goal: [best.x, best.y],
          label: `Collect ${Math.round(best.v)} XP worth of gems ${Math.round(best.d)} px to the ${dirName([best.x - pl.x, best.y - pl.y])}`,
          score: 0.3 + Math.min(0.4, best.v * 0.05) - best.risk * 0.15 + (near200 === 0 ? 0.25 : 0) + (best.risk < 0.3 && best.v >= 3 ? 0.2 : 0)
            + (calm && best.risk < 0.5 ? 0.3 : 0) - Math.min(0.3, best.d / 3000),
          numbers: { xp_value: Math.round(best.v), distance_px: Math.round(best.d), enemies_near_gems: r1(best.risk), xp_to_next_level: Math.round(pl.xpNext - pl.xp) }
        });
      }
    }

    // Curarse: baya o manantial.
    const h = F.heal && F.spring ? (F.heal.d < F.spring.d ? F.heal : F.spring) : F.heal || F.spring;
    if (h && hp < 0.7) {
      out.push({
        id: 'heal', kind: 'goto', goal: [h.x, h.y], stay: h.kind === 'spring',
        label: h.kind === 'spring' ? `Stand on the healing spring ${Math.round(h.d)} px away` : `Grab the berry ${Math.round(h.d)} px away`,
        score: 0.3 + (0.7 - hp) * 1.2 - Math.min(0.3, h.d / 1500),
        numbers: { hp_percent: Math.round(hp * 100), distance_px: Math.round(h.d), heals: h.kind === 'spring' ? '14% max HP per second while on it' : 'berry' }
      });
    }

    // Cebar una trampa: pasar junto a ella con los perseguidores detrás (no pisarla).
    const chasers = F.enemies.filter(x => !x.th.keeper && !x.e.flying && !x.e.boss && x.d < 300);
    if (F.traps.length && chasers.length >= 2) {
      let best = null;
      for (const t of F.traps) {
        if (t.d > 360 || t.d < 30) continue;
        // ¿Cuántos perseguidores pasarían por ella si la cruzamos? (los que vienen por detrás)
        const [ux, uy] = U.norm(t.x - pl.x, t.y - pl.y);
        const behind = chasers.filter(x => ((x.e.x - pl.x) * ux + (x.e.y - pl.y) * uy) < 0).length;
        if (!best || behind > best.behind) best = { ...t, behind, dir: [ux, uy] };
      }
      if (best && best.behind >= 2) {
        const dmg = best.kind === 'explosive' ? 90 + pl.level * 18 : best.kind === 'poison' ? 14 + pl.level * 3 : 4;
        out.push({
          id: 'lure_trap', kind: 'lure', trap: [best.x, best.y],
          label: `Lure ${best.behind} chasers over the ${best.kind} trap ${Math.round(best.d)} px away (pass beside it, do not step on it)`,
          score: 0.3 + (best.kind === 'explosive' ? 0.25 : best.kind === 'sticky' ? 0.1 : 0.15) + Math.min(0.2, best.behind * 0.04) - (hp < 0.35 ? 0.2 : 0),
          numbers: { trap: best.kind, distance_px: Math.round(best.d), chasers_behind: best.behind, damage_to_each_enemy: dmg, effect_radius_px: 74, hurts_you_within_px: 52 }
        });
      }
    }

    // Vuelta grande: el plan por defecto sin jefe y sin cerco, con un ataque a distancia.
    const rangedSlot = F.slots.filter(s => s.baseDps > 0 && s.range >= 180 && !s.melee).sort((a, b) => b.dps - a.dps)[0];
    if (rangedSlot && F.enemies.length) {
      const R0 = U.clamp(rangedSlot.range * 0.62, 200, 330);
      const o = orbitPlan(pl, F, R0);
      const tail = F.enemies.filter(x => !x.th.keeper && x.d < 450).length;
      let onGems = 0, onXp = 0;
      for (const g of F.gems) if (Math.abs(Math.hypot(g.x - o.A[0], g.y - o.A[1]) - o.R) < 80) { onGems++; onXp += g.v; }
      const centerD = Math.hypot(pl.x - o.A[0], pl.y - o.A[1]);
      const boss = F.enemies.some(x => x.e.boss);
      out.push({
        id: 'circle_kite', kind: 'circle', slot: rangedSlot.index, anchor: o.A, R: o.R, dir: o.dir,
        label: `Run a ${Math.round(o.R)} px circle ${o.dir > 0 ? 'counter-clockwise' : 'clockwise'} with the horde trailing behind, shooting with slot ${rangedSlot.index + 1}; pick up gems on the way`,
        score: 0.9 + (o.clear ? 0.05 : -0.4) - (F.occupied >= 9 ? 0.3 : 0) - (boss ? 0.2 : 0) - (hp < 0.3 ? 0.1 : 0),
        numbers: {
          center_distance_px: Math.round(centerD), radius_px: Math.round(o.R), tail_enemies: tail,
          gems_on_circle: onGems, xp_on_circle: Math.round(onXp), route_clear: o.clear, blocked_points_of_28: o.bad,
          slot: rangedSlot.index + 1, dps_vs_nearby: Math.round(rangedSlot.dps), hit_range_px: Math.round(rangedSlot.range)
        }
      });
    }

    // Sin nada cerca: explorar (las gemas y los enemigos salen fuera de la vista).
    if (!F.enemies.length && !F.gems.length) {
      out.push({ id: 'roam', kind: 'roam', label: 'Nothing nearby: roam to find enemies and gems', score: 0.3, numbers: {} });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 6);
  }

  // (El resumen de reglas que lee Jev está en el servidor: mcp/src/jev-core.js GAME_RULES.)

  return { facts, candidates, hitRange, engageDist, moveDps, threatOf, targetFor, drySpd };
})();
