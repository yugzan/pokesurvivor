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
 * Objetos del mapa (versión del 2026-10-16):
 *   - grieta: dura 45 s y se entra a <30 px de (x, y−10) (rift.js:25, :42); el legendario sale del
 *     grupo de legendarios con sprite, ×4 los que aún no has vencido (rift.js:92-98); vida
 *     (3200 + 9·t)·coop, contacto 36 + t/20, disparo 18 + t/40 (rift.js:143-149); arena 120 s (rift.js:26)
 *   - ganar: vínculo (rift.js:199), 3 tickets y 80 monedas (enemy.js:187-191), objeto y 50 monedas
 *     (enemy.js:172-176), ×10 la mitad de las veces (pickup.js:28, :85), su experiencia (enemy.js:178)
 *   - perder (KO o 120 s): vuelves sin premio, revivido al 30 % si caíste (rift.js:183, :229); no es
 *     el fin de la partida (game.js:635); los enemigos del mapa esperan guardados (rift.js:120)
 *   - altar: poder de 25 s (Furia daño ×2, Rayo +45 % velocidad, Imán ×4 radio, Prisa −40 % recarga)
 *     al tocarlo a < max(30, r + tu radio + 14) (interact.js:17-24, :38); sustituye al poder que
 *     tengas (player.js:300-303)
 *   - cofre con candado: a < max(46, r + tu radio + 24) suma 3,5 s; lejos se pierde a ×1,5
 *     (interact.js:17, :41-45); botín: 9×4 monedas, 1–3 tickets, ×10 15 %, objeto 50 %, un nivel de XP
 *     (world.js:412-423)
 *   - roca 34 PV, cofre 22 PV (world.js:169-172); el daño a objetos es dmg·atk sin tipos, clima ni
 *     crítico (world.js:357-363, combat.js:139, :194, :592); roca: XP 6 al 40 %, monedas 25 %, baya 6 %
 *     (world.js:396-399); cofre: 4–7×3 monedas, baya o imán, XP 20, objeto 8 % (world.js:406-410)
 *   - el apuntado automático sólo va a una roca/cofre (a <200 px) si no hay NINGÚN enemigo a <520 px
 *     (player.js:372-375); aura, órbita y nova dan a los objetos sin apuntar (combat.js:194, :587-593)
 *   - botín: los objetos del suelo no caducan; el imán (78 px) los atrae y se cogen a 15 px
 *     (player.js:25, pickup.js:131, :147)
 *   - cobertura: los disparos enemigos chocan con paredes y objetos sólidos (árbol, roca, cofre,
 *     altar, cofre con candado) (combat.js:559-563, world.js:345-353); sólo 'ranged', 'fan' y los
 *     jefes disparan proyectiles; 'beamer' y 'zoner' ponen avisos en el suelo que no se tapan
 *     (enemy.js:568-582); los que vuelan pasan por encima de todo y no rodean (enemy.js:49, :332, :381)
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
    const gems = [], loot = [];
    let heal = null;
    for (const p of G.Pickups.all()) {
      const d = Math.hypot(p.x - pl.x, p.y - pl.y);
      if (d > 1100) continue;                // no caducan: también las que quedaron atrás (se vuelve a por ellas)
      if (p.kind === 'heal') { if (!heal || d < heal.d) heal = { x: p.x, y: p.y, d, kind: 'berry' }; continue; }
      // Botín raro: táctica aparte ('loot').
      if (LOOT_VAL[p.kind]) { loot.push({ x: p.x, y: p.y, d, kind: p.kind, value: p.value }); continue; }
      const v = p.kind === 'xpBig' ? 3 : p.kind === 'xp' ? 1 : p.kind === 'magnet' ? 4 : 0.5;
      gems.push({ x: p.x, y: p.y, d, v });
    }
    const traps = [], altars = [], bigchests = [];
    let spring = null;
    for (const p of G.World.specialsNear(pl.x, pl.y, NEAR)) {
      const d = Math.hypot(p.x - pl.x, p.y - pl.y);
      if (p.type === 'trap') { if (d <= 420) traps.push({ x: p.x, y: p.y - 8, d, kind: ['poison', 'sticky', 'explosive'][p.kind] || 'trap' }); }
      else if (p.type === 'spring') { if (d <= 420 && p.charge > 0.25 && (!spring || d < spring.d)) spring = { x: p.x, y: p.y - 8, d, kind: 'spring' }; }
      else if (p.type === 'altar' && !p.used) altars.push({ p, d });
      else if (p.type === 'bigchest') bigchests.push({ p, d });
    }
    // Rocas y cofres (sólidos que se rompen).
    const breakables = [];
    for (const p of G.World.propsInCircle(pl.x, pl.y, NEAR)) if (p.solid && p.destructible && p.hp > 0) breakables.push({ p, d: Math.hypot(p.x - pl.x, p.y - pl.y) });
    const liq = G.World.liquidEffect([]);         // lo que hace el charco de este bioma a quien no es inmune
    return { pl, hpFrac, enemies, slots, occupied, gap, gems, loot, heal, spring, traps, altars, bigchests, breakables, liquid: G.World.liquidKind(), liquidHurts: !!liq.dmg };
  }

  // ---------------- conocimiento: objetos del mapa ----------------

  const LOOT_VAL = { ticket10: 0.35, item: 0.3, ticket: 0.2 };
  const SHOOTS = ['ranged', 'fan'];                       // disparan proyectiles (los tapan paredes y árboles)
  const PROP_AIMED = ['projectile', 'melee', 'beam', 'boomerang', 'cone', 'dash'];   // dan al objeto si se le apunta
  const PROP_ALWAYS = ['nova', 'aura', 'orbit'];          // dan a lo que tocan, sin apuntar
  const POWER_EN = {
    dmg: ['damage x2', 0.3], spd: ['+45% move speed', 0.1], mag: ['pickup magnet radius x4', 0.12], cd: ['-40% cooldowns', 0.25]
  };

  /** Números para Jev: como mucho 16 y textos de 80 (lo que deja pasar mcp/src/jev-http.js sanitizeTactics). */
  function clip(nums) {
    const o = {};
    for (const [k, v] of Object.entries(nums)) {
      if (Object.keys(o).length >= 16) break;
      o[k] = typeof v === 'string' && v.length > 80 ? v.slice(0, 79) + '…' : v;
    }
    return o;
  }

  /** ¿No se puede cambiar de hueco? 'choice band' (Cinta Elección) o 'manual' (fijado a mano, autopilot.js holdSlot). */
  function slotFixed(pl) {
    if (pl.hasItem('choiceband') && pl.slots[pl.active]) return 'choice band';
    if (G.Autopilot && G.Autopilot.slotLocked) return 'manual';
    return null;
  }

  /** ¿Hay algún enemigo a < r? (el apuntado mira a todos, también al duende del tesoro) */
  function enemyWithin(x, y, r) {
    for (const e of G.EnemyMgr.all()) if (!e.dead && (e.x - x) ** 2 + (e.y - y) ** 2 < r * r) return true;
    return false;
  }

  /** Daño por segundo de un hueco contra un objeto (sin tipos, clima ni crítico). aimFree: el apuntado va al objeto. */
  function propDps(pl, slot, aimFree) {
    let v = 0, best = null, bv = 0;
    for (const m of slot.moves) {
      if (!m.dmg || !(PROP_ALWAYS.includes(m.kind) || (aimFree && PROP_AIMED.includes(m.kind)))) continue;
      const sh = (SHAPE[m.kind] || SHAPE.buff)(m);
      const cd = m.kind === 'orbit' ? Math.max(0.12, m.cd) : Math.max(0.12, m.cd * pl.cdMul);
      const x = m.dmg * pl.atk * sh[0] / cd;
      v += x;
      if (x > bv) { bv = x; best = m; }
    }
    return { dps: v, move: best };
  }

  /** Distancias (desde el centro del objeto) entre las que el movimiento le da. */
  function propBand(m, p) {
    switch (m.kind) {
      case 'melee': case 'aura': return [0, m.radius + p.r - 6];
      case 'orbit': return [Math.max(0, m.radius - p.r - (m.size || 8) + 4), m.radius + p.r + (m.size || 8) - 4];
      case 'beam': case 'dash': return [0, m.radius * 0.8];
      default: return [0, Math.min(170, hitRange(m) * 0.8)];
    }
  }

  const BALLISTIC = ['projectile', 'boomerang', 'cone', 'nova'];   // vuelan: un árbol o una pared en medio se los come
  /**
   * Sitio desde el que un movimiento que se apunta le da al objeto p: libre, a tiro, con p como roca/cofre
   * más cercano (player.js: el apuntado va a nearestBreakable) y, si vuela, sin nada sólido en medio.
   */
  function standSpot(pl, p, m, hi) {
    const r = Math.max(8, pl.r * 0.8), minD = pl.r + p.r + 4;
    const rr = BALLISTIC.includes(m.kind) ? Math.max(minD, Math.min(hi, 150) * 0.75) : Math.max(minD, hi - 14);
    if (rr > hi) return null;
    const a0 = Math.atan2(pl.y - p.y, pl.x - p.x);
    let best = null, bd = Infinity;
    for (let i = 0; i < 16; i++) {
      const a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 8;
      const x = p.x + Math.cos(a) * rr, y = p.y + Math.sin(a) * rr;
      if (!G.World.isFree(x, y, r)) continue;
      if (m.kind !== 'nova' && G.World.nearestBreakable(x, y, 200) !== p) continue;     // la nova no apunta
      if (BALLISTIC.includes(m.kind) && !clearShot(x, y, p)) continue;
      const d = Math.hypot(x - pl.x, y - pl.y);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    return best;
  }

  /** Sitio para que los orbes (elipse de radio R × 0,7R) pasen por el objeto p. */
  function orbitSpot(pl, p, m) {
    const R = m.radius, r = Math.max(8, pl.r * 0.8);
    let best = null, bd = Infinity;
    for (const [ox, oy] of [[R, 0], [-R, 0], [0, R * 0.7], [0, -R * 0.7]]) {
      const x = p.x + ox, y = p.y + oy;
      if (!G.World.isFree(x, y, r)) continue;
      const d = Math.hypot(x - pl.x, y - pl.y);
      if (d < bd) { bd = d; best = [x, y]; }
    }
    return best;
  }

  /** ¿Llega un disparo tuyo de (x, y) al objeto p? (lo para una pared o cualquier otro sólido) */
  function clearShot(x, y, p) {
    const d = Math.hypot(p.x - x, p.y - y), n = Math.ceil(d / 8);
    for (let i = 1; i < n; i++) {
      const bx = x + (p.x - x) * i / n, by = y + (p.y - y) * i / n, blk = G.World.projectileBlock(bx, by, 6);
      if (blk && blk !== p) return false;
      if (blk === p) return true;
    }
    return true;
  }

  /** Tiempo andando en línea recta (el agua frena; ×1,15 por rodeos). */
  function walkTime(pl, x, y) {
    const dry = Math.max(30, drySpd(pl)), slow = (G.World.liquidEffect(pl.mon.types) || {}).slow || 1;
    const d = Math.hypot(x - pl.x, y - pl.y), n = Math.max(1, Math.ceil(d / 16));
    let t = 0;
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      t += d / n / (slow < 1 && G.World.isLiquid(pl.x + (x - pl.x) * k, pl.y + (y - pl.y) * k) ? dry * slow : dry);
    }
    return t * 1.15;
  }

  /** Legendarios posibles de la grieta, con su peso (rift.js start). Se recalcula cada 5 s. */
  let legCache = null, legAt = 0;
  function legendPool() {
    const now = performance.now();
    if (legCache && now - legAt < 5000) return legCache;
    const beaten = (G.DB.save && G.DB.save.legends) || {};
    legCache = G.DEX.filter(p => p.leg && G.SPRITE_META[p.dex]).map(p => ({ types: p.types, w: beaten[p.dex] ? 1 : 4 }));
    legAt = now;
    return legCache;
  }

  /** ¿Choca un disparo enemigo entre (ax, ay) y (bx, by)? */
  function shotBlocked(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / 10);
    for (let i = 1; i < n; i++) if (G.World.projectileBlock(ax + (bx - ax) * i / n, ay + (by - ay) * i / n, 7)) return true;
    return false;
  }

  /** Mejor sitio a cubierto (árbol, roca, cofre, pared) de los que disparan. */
  let lastCover = null;          // el elegido antes: se mantiene si sigue tapando (que no cambie de sitio a cada paso)
  function coverSpot(pl, shooters) {
    const TS = G.World.TS, r = Math.max(8, pl.r * 0.8);
    let cx = 0, cy = 0;
    for (const s of shooters) { cx += s.e.x; cy += s.e.y; }
    cx /= shooters.length; cy /= shooters.length;
    const spots = [];
    for (const p of G.World.propsNear(pl.x, pl.y, 240)) if (p.solid) spots.push({ x: p.x, y: p.y, rr: p.r, what: p.type });
    const t0x = Math.floor((pl.x - 240) / TS), t0y = Math.floor((pl.y - 240) / TS);
    for (let j = 0; j <= Math.ceil(480 / TS); j++) for (let i = 0; i <= Math.ceil(480 / TS); i++) {
      const x = (t0x + i + 0.5) * TS, y = (t0y + j + 0.5) * TS;
      if (G.World.isWall(x, y)) spots.push({ x, y, rr: TS * 0.5, what: 'wall' });
    }
    let best = null;
    const list = spots.map(s => ({ ...s, d: Math.hypot(s.x - pl.x, s.y - pl.y) })).sort((a, b) => a.d - b.d).slice(0, 24);
    const cands = list.map(s => {
      const [ux, uy] = U.norm(s.x - cx, s.y - cy);
      return { x: s.x + ux * (s.rr + pl.r + 6), y: s.y + uy * (s.rr + pl.r + 6), what: s.what, keep: 0 };
    });
    if (lastCover && performance.now() - lastCover.t < 1500) cands.unshift({ ...lastCover, keep: 0.6 });
    for (const { x, y, what, keep } of cands) {
      if (!G.World.isFree(x, y, r)) continue;
      const d = Math.hypot(x - pl.x, y - pl.y);
      if (d > 240) continue;
      let blocked = 0;
      // Tapado también si el que dispara se mueve un poco de lado (±24 px): no vale rozar el borde.
      for (const sh of shooters) {
        const [nx, ny] = U.norm(y - sh.e.y, sh.e.x - x);
        if ([-24, 0, 24].every(o => shotBlocked(sh.e.x + nx * o, sh.e.y + ny * o, x, y))) blocked++;
      }
      const sc = blocked - d / 300 + keep;
      if (blocked && (!best || sc > best.sc)) best = { x, y, d, blocked, what, sc };
    }
    if (best) lastCover = { x: best.x, y: best.y, what: best.what, t: performance.now() };
    return best;
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
    mapTactics(pl, F, out, { near200, hp, calm, ranked });
    out.sort((a, b) => b.score - a.score);
    // Máximo 6, pero salir del cerco, curarse y la grieta (rara y con 45 s) no se quedan fuera:
    // sustituyen a la peor que no sea de las protegidas.
    const KEEP = ['evade', 'heal', 'rift'];
    const top = out.slice(0, 6);
    for (const c of out.slice(6)) {
      if (!KEEP.includes(c.id)) continue;
      const i = top.map(x => !KEEP.includes(x.id)).lastIndexOf(true);
      if (i >= 0) top[i] = c;
    }
    return top.sort((a, b) => b.score - a.score);
  }

  /** Tácticas con objetos del mapa: grieta, altar, cofre con candado, romper, botín y cobertura. */
  function mapTactics(pl, F, out, { near200, hp, calm, ranked }) {
    const chasersNear = (x, y, r) => F.enemies.filter(v => !v.th.keeper && Math.hypot(v.e.x - x, v.e.y - y) < r).length;
    const arena = G.Rift.inArena;

    // Grieta: pelea contra un legendario (perder no acaba la partida).
    const rf = G.Rift.rift;
    if (rf && !arena && ranked.length) {
      const gx = rf.x, gy = rf.y - 10, d = Math.hypot(gx - pl.x, gy - pl.y);
      const travel = walkTime(pl, gx, gy);
      if (travel < rf.ttl - 0.5) {
        const pool = legendPool(), W = pool.reduce((a, p) => a + p.w, 0) || 1;
        const t = G.Game.st.time, n = G.Game.everyone().length;
        const legHp = Math.round((3200 + t * 9) * G.Coop.scaleHp(n) * (n > 1 ? 1.4 : 1));
        // Con Cinta Elección o con el hueco fijado a mano se pelea con el activo: se calcula con ése.
        const fixed = slotFixed(pl);
        const pickFrom = fixed ? F.slots.filter(s => s.index === pl.active && s.baseDps > 0) : ranked;
        const per = [];
        for (const s of pickFrom) {
          let k = 0, dps = 0;
          for (const p of pool) {
            k += G.Types.mult(s.main.type, p.types) * p.w;
            for (const m of s.moves) dps += moveDps(pl, m, null) * G.Types.mult(m.type, p.types) * p.w;
          }
          per.push({ s, k: k / W, dps: dps / W });
        }
        per.sort((a, b) => b.dps - a.dps);
        const best = per[0];
        if (best) {
          const ttk = legHp / Math.max(1, best.dps);
          // Tipos más probables del legendario.
          const tw = {};
          for (const p of pool) for (const ty of p.types) tw[ty] = (tw[ty] || 0) + p.w / W;
          const likely = Object.entries(tw).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ');
          // (Como mucho 16 números y textos de 80: lo que el servidor deja pasar a Jev, mcp/src/jev-http.js LIMITS.)
          const others = per.slice(1).map(x => `slot ${x.s.index + 1}: ${Math.round(x.dps)} dps x${r1(x.k)}`).join('; ');
          out.push({
            id: 'rift', kind: 'goto', goal: [gx, gy], within: 18, commit: true, slot: best.s.index,
            label: `Enter the rift ${Math.round(d)} px away and fight a legendary in its arena (${Math.round(rf.ttl)} s left to enter)`,
            score: 0.55 + (ttk < 60 ? 0.5 : ttk < 100 ? 0.25 : -0.15) + (hp >= 0.6 ? 0.05 : hp < 0.35 ? -0.3 : -0.1) - (near200 >= 3 ? 0.2 : 0) - Math.min(0.2, travel / 60),
            numbers: clip({
              est_seconds_to_kill: Math.round(ttk), arena_time_limit_s: 120, rift_seconds_left: Math.round(rf.ttl), walk_seconds: r1(travel),
              distance_px: Math.round(d), hp_percent: Math.round(hp * 100),
              slot: best.s.index + 1, dps_vs_legend: Math.round(best.dps), type_mult_vs_legends: r1(best.k),
              ...(fixed ? { slot_fixed: fixed } : {}),
              legend_hp: legHp, legend_contact_damage: Math.round(36 + t / 20), legend_likely_types: likely,
              win_reward: 'bond (fuse 2 moves), 3 tickets, 50% x10 ticket, held item, 130 coins, XP',
              lose_or_timeout: 'no reward; revived at 30% HP if KO; run goes on; map enemies wait',
              ...(others ? { other_slots: others } : {})
            })
          });
        }
      }
    }
    if (arena) return;                     // en la arena no hay altares ni cofres; los demás no tienen sentido

    // Altar: un poder de 25 s.
    let al = null;
    for (const a of F.altars) { const k = POWER_EN[(G.Interact.POWERS[a.p.kind] || {}).id]; if (k && (!al || a.d < al.d)) al = a; }
    if (al) {
      const pw = G.Interact.POWERS[al.p.kind], [eff, val] = POWER_EN[pw.id];
      const foes = chasersNear(al.p.x, al.p.y, 200);
      const act = F.slots[pl.active];
      const extra = pw.id === 'dmg' ? { dps_now: Math.round(act ? act.dps : 0), dps_with_power: Math.round((act ? act.dps : 0) * 2) }
        : pw.id === 'cd' ? { dps_now: Math.round(act ? act.dps : 0), dps_with_power: Math.round((act ? act.dps : 0) / 0.6) }
        : pw.id === 'spd' ? { speed_now: Math.round(drySpd(pl)), speed_with_power: Math.round(drySpd(pl) * 1.45) }
        : { magnet_radius_now: Math.round(pl.magnet), magnet_radius_with_power: Math.round(pl.magnet * 4), gems_within_new_radius: F.gems.filter(g => g.d < pl.magnet * 4).length };
      out.push({
        id: 'altar', kind: 'goto', goal: [al.p.x, al.p.y], within: Math.max(30, al.p.r + pl.r + 14) - 6,
        label: `Touch the altar ${Math.round(al.d)} px away for the ${pw.name} power (${eff}, 25 s)`,
        score: 0.45 + val + (pw.id === 'mag' && F.gems.length >= 10 ? 0.1 : 0) - al.d / 1500 - foes * 0.06 + (calm ? 0.15 : 0) - (hp < 0.35 ? 0.2 : 0),
        numbers: clip({
          power: pw.name, effect: eff, duration_s: 25, distance_px: Math.round(al.d), walk_seconds: r1(walkTime(pl, al.p.x, al.p.y)),
          enemies_within_200px_of_altar: foes, ...extra,
          ...(pl.power ? { replaces_current_power: pl.power.def.name + ' (' + Math.round(pl.power.t) + ' s left)' } : {})
        })
      });
    }

    // Cofre con candado: quedarse a su lado 3,5 s.
    const bc = F.bigchests.sort((a, b) => a.d - b.d)[0];
    if (bc) {
      const p = bc.p, R = Math.max(46, p.r + pl.r + 24);
      const need = Math.max(0, G.Interact.CHEST_TIME - p.open);
      const foes = chasersNear(p.x, p.y, 200);
      let inc = 0;
      for (const v of F.enemies) {
        const dd = Math.hypot(v.e.x - p.x, v.e.y - p.y);
        if (v.th.keeper ? dd < 320 : dd < 200) inc += v.th.keeper ? v.th.shot : v.th.contact;
      }
      out.push({
        id: 'bigchest', kind: 'goto', goal: [p.x, p.y], within: R - 10,
        label: `Open the locked chest ${Math.round(bc.d)} px away: stand next to it for ${r1(need)} s`,
        score: 0.8 - bc.d / 1500 - foes * 0.08 + (calm ? 0.2 : 0) - (hp < 0.35 ? 0.3 : 0) - Math.min(0.3, inc * need / Math.max(1, pl.hp)),
        numbers: clip({
          open_seconds_needed: r1(need), distance_px: Math.round(bc.d), walk_seconds: r1(walkTime(pl, p.x, p.y)), stand_within_px: Math.round(R),
          enemies_within_200px_of_chest: foes, incoming_dps_near_chest: Math.round(inc), hp_percent: Math.round(hp * 100),
          loot: '36 coins, 1-3 tickets, 15% x10 ticket, 50% held item, XP for 1 level',
          stepping_away: 'progress drains 1.5x faster than it fills'
        })
      });
    }

    // Romper una roca o un cofre: el apuntado sólo va a ellos sin enemigos a <520 px (o con aura/órbita/nova).
    // Con Cinta Elección o el hueco fijado a mano, sólo el hueco activo.
    if (F.breakables.length) {
      const fixed = slotFixed(pl);
      const slots = fixed ? F.slots.filter(s => s.index === pl.active) : F.slots;
      let best = null;
      for (const b of F.breakables) {
        const p = b.p, aimFree = !enemyWithin(pl.x, pl.y, 520) && !enemyWithin(p.x, p.y, 520);
        for (const s of slots) {
          const pd = propDps(pl, s, aimFree);
          if (!pd.move || pd.dps <= 0) continue;
          // Dónde ponerse: los que se lanzan al blanco necesitan un sitio desde el que el objeto sea el
          // más cercano (el apuntado) y, los que vuelan, sin árbol ni pared en medio (combat.js resolve).
          // Aura: un círculo alrededor de ti; órbita: una elipse (radio ×0,7 en vertical, projectile.js:51-52).
          let goal = [p.x, p.y], [lo, hi] = propBand(pd.move, p), within = hi, near = lo;
          if (pd.move.kind === 'orbit') {
            const st = orbitSpot(pl, p, pd.move);
            if (!st) continue;
            goal = st; within = Math.max(4, p.r + (pd.move.size || 8) - 8); near = 0;
          } else if (pd.move.kind !== 'aura') {
            const st = standSpot(pl, p, pd.move, hi);
            if (!st) continue;
            goal = st; within = 12; near = 0;
          }
          const secs = p.hp / pd.dps;
          const sc = 0.3 + (p.type === 'chest' ? 0.25 : 0) - Math.min(0.3, secs * 0.02) - b.d / 1500 + (calm ? 0.15 : 0) + (s.index === pl.active ? 0.03 : 0);
          if (!best || sc > best.sc) best = { b, s, pd, secs, sc, aimFree, goal, within, near, hi };
        }
      }
      if (best) {
        const p = best.b.p;
        const foes = chasersNear(p.x, p.y, 250);
        // Si hay que cambiar de hueco, se cambia sin esperar (el activo puede no darle: Cadena, Meteoro...).
        const needSlot = best.s.index !== pl.active;
        if (foes < 3) out.push({
          id: 'break', kind: 'goto', goal: best.goal, within: best.within, near: best.near, prop: [p.x, p.y], slot: best.s.index, needSlot,
          label: `Break the ${p.type} ${Math.round(best.b.d)} px away with slot ${best.s.index + 1} (${r1(best.secs)} s)`,
          score: best.sc - foes * 0.1,
          numbers: clip({
            prop: p.type, prop_hp: Math.round(p.hp), seconds_to_break: r1(best.secs), dps_vs_prop: Math.round(best.pd.dps),
            slot: best.s.index + 1, ...(needSlot ? { switches_slot: true } : {}), ...(fixed ? { slot_fixed: fixed } : {}),
            distance_px: Math.round(best.b.d), stand_within_px: Math.round(best.hi), enemies_within_250px: foes,
            drops: p.type === 'chest' ? '12-21 coins, a berry or a magnet, 20 XP, 8% held item' : '40% 6 XP, 25% 2 coins, 6% berry',
            ...(best.aimFree ? {} : { note: 'enemies within 520 px take the aim: only aura/orbit/nova hit it' })
          })
        });
      }
    }

    // Botín raro del suelo (tickets, objetos): no caduca.
    if (F.loot.length) {
      let best = null;
      for (const l of F.loot) {
        let risk = 0;
        for (const x of F.enemies) if (!x.th.keeper) risk += Math.exp(-Math.hypot(x.e.x - l.x, x.e.y - l.y) / 70);
        const s = LOOT_VAL[l.kind] - risk * 0.15 - l.d / 3000;
        if (!best || s > best.s) best = { ...l, risk, s };
      }
      const it = best.kind === 'item' && G.Items.BY[best.value];
      const what = best.kind === 'ticket10' ? 'x10 gacha ticket' : best.kind === 'ticket' ? 'gacha ticket' : 'held item ' + (it ? it.name : '?');
      if (best.risk < 3) out.push({
        id: 'loot', kind: 'goto', goal: [best.x, best.y], within: 10,
        label: `Pick up the ${what} ${Math.round(best.d)} px to the ${dirName([best.x - pl.x, best.y - pl.y])}`,
        score: 0.4 + best.s + (calm ? 0.25 : 0) + (near200 === 0 ? 0.1 : 0),
        numbers: clip({
          kind: best.kind, ...(it ? { item: it.name, item_effect: it.desc, held_item_now: pl.item ? G.Items.BY[pl.item].name : 'none' } : {}),
          distance_px: Math.round(best.d), walk_seconds: r1(walkTime(pl, best.x, best.y)), enemies_near_loot: r1(best.risk),
          rare_drops_on_floor: F.loot.length, expires: false
        })
      });
    }

    // Cobertura: un árbol, roca o pared entre tú y los que disparan.
    const shooters = F.enemies.filter(v => (SHOOTS.includes(v.e.behavior) || v.e.boss) && v.d < 400).slice(0, 6);
    if (shooters.length) {
      const shots = G.Projectiles.all().filter(s => !s.friendly && !s.dead && Math.hypot(s.x - pl.x, s.y - pl.y) < 400
        && ((pl.x - s.x) * (s.vx || 0) + (pl.y - s.y) * (s.vy || 0)) > 0).length;
      const chasers = chasersNear(pl.x, pl.y, 260);
      if ((shots >= 1 || shooters.length >= 2) && chasers < 3) {
        const cv = coverSpot(pl, shooters);
        if (cv && cv.blocked >= Math.ceil(shooters.length / 2)) {
          const fly = shooters.filter(v => v.e.flying).length;
          const zon = F.enemies.filter(v => (v.e.behavior === 'beamer' || v.e.behavior === 'zoner') && v.d < 400).length;
          out.push({
            id: 'cover', kind: 'goto', goal: [cv.x, cv.y], within: 12,
            label: `Take cover behind the ${cv.what} ${Math.round(cv.d)} px away from ${cv.blocked} of ${shooters.length} shooters`,
            score: 0.35 + 0.12 * cv.blocked + Math.min(0.3, shots * 0.08) - chasers * 0.08 - cv.d / 1000 + (hp < 0.5 ? 0.1 : 0),
            numbers: clip({
              shooters_nearby: shooters.length, flying_shooters: fly, shooters_blocked: cv.blocked, incoming_shots: shots,
              cover: cv.what, cover_distance_px: Math.round(cv.d), chasers_within_260px: chasers,
              ...(fly ? { note_flying: 'their shots are blocked too, but they fly over obstacles to a new angle' } : {}),
              ...(zon ? { floor_warning_casters_not_blocked: zon } : {})
            })
          });
        }
      }
    }
  }

  // (El resumen de reglas que lee Jev está en el servidor: mcp/src/jev-core.js GAME_RULES.)

  return { facts, candidates, hitRange, engageDist, moveDps, threatOf, targetFor, drySpd };
})();
