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
 *   - daño = dmg · atkFor(m) (Ataque o At. Esp. según el movimiento, stats.js) · Defensa o Def. Esp. del
 *     enemigo (G.Stats.taken) · tipos (types.js, ×1.6 / ×0.6 / ×0.3, tope 0.3–2.4) · clima (weather.js)
 *   - contacto: e.dmg cada 0.55 s como mucho (combat.js resolve); con cuerpo a cuerpo activo, −25 %
 *   - disparos enemigos 190 px/s (enemy.js shoot); los que guardan distancia: enemy.js keepsDistance
 *   - trampas: veneno / pegajosa / explosiva en 74 px; saltan al pisarlas un enemigo que no vuela
 *     o tú; a ti te afectan a <52 px (interact.js)
 *   - lava y demás charcos que queman: los enemigos los rodean (pathing.js), no sirven de cebo
 * Daño de cada movimiento (versión del 2026-10-18; moveRates / dpsOn): golpes contados con la geometría
 * real de cada forma, desde donde estarás (a engageDist del más cercano) contra el grupo de < 250 px:
 *   - recarga max(0,05, cd · cdMul); los que necesitan blanco no se lanzan si no está a reach() (combat.js:27-41, :68-77)
 *   - proyectil: abanico (i/(n−1) − 0,5)·spread·n, ±0,03 rad al azar, perfora `pierce` (combat.js:86-104)
 *   - nova: n en círculo, cada uno se para en el primero; teledirigido: se curva (projectile.js:70-80) (combat.js:106-121)
 *   - cono: abanico `arc`, alcance speed·life ×0,85–1,1 ×0,85–1,05 (combat.js:338-350); cuerpo a cuerpo: arco en
 *     radius + radio del enemigo (combat.js:128-141); rayo: franja; embestida: cápsula (combat.js:143-170, :296-322)
 *   - bumerán: va `radius` y vuelve, 2 golpes; con 2+ se abren ±spread (combat.js:212-224): ¡con 2 no da al de delante!
 *   - cadena: salta al más cercano a < radius, ×0,85 cada salto (combat.js:227-254); meteoro: uno por enemigo a
 *     < 340, los que sobran en 280 × 220 a tu alrededor (combat.js:271-283)
 *   - torreta: detrás de ti, dispara cada `rate` al más cercano a < range durante min(dur, count·recarga), el
 *     primero a 0,3 s (combat.js:285-294, :384-400): ~10× lo que se suponía
 *   - órbita: elipse radius × 0,7·radius a `speed` rad/s; cada orbe vuelve a dar cada max(0,12, cd) sólo mientras
 *     toca: 1 + ⌊tiempo encima / cd⌋ golpes por pasada (combat.js:468-500, :618-623): ~4× menos que lo supuesto
 *   - minas: estallan si alguien pasa a < 14 px + su radio, las viejas se quitan al pasar de 4 + 2·count
 *     (combat.js:257-269, :366-375); rastro: charcos que dañan cada 0,5 s (combat.js:324-336, :401-404)
 *   - quemadura 1,6·pilas·(1 + 0,06·nivel) cada 0,5 s, veneno 1,2 %·vida máx.·pilas + 1 cada 0,6 s; tope 8 pilas,
 *     duran 3 / 4 s desde el último golpe (enemy.js:146-153, :255-263); media en lo que tarda en caer (máx. 15 s)
 *   - medido en el juego (banco de pruebas, 2026-10-18): parte de minas que pisan los perseguidores MINE_ON y
 *     del rastro TRAIL_ON (dependen de cómo te persiguen; no salen de una regla)
 *   - monotipo (19-10-2026): ×1,2 con los de su tipo si sólo tiene uno (player.js atkFor / MONO_K / monoType):
 *     entra solo porque dpsOn usa pl.atkFor(m)
 *   - naturaleza (21-10-2026, systems/mons.js monFor): ±10 % a dos stats de pl.mon; entra sola por atkFor y G.Stats.taken
 *   - habilidad (21-10-2026, data/ability-fx.js en pl.abil): × out(pl, m, e) al daño hecho, crítico ×critMul (si no
 *     ×1,5), Potencia Bruta (sheer) quita quemadura y veneno y Dicha (serene) los dobla (combat.js abilOut/critMul/
 *     statusK); statusCd a la recarga de los potenciadores (combat.js tickMove); al recibir (player.js hurt, no
 *     "pure"): absorb de su tipo = 0, × (1 − dodge) de media y × inMul
 * Familias nuevas (combat.js del 2026-10-19, funciones por nombre; todas necesitan blanco: combat.js TARGETED):
 *   - homing: fireProjectiles con m.homing (se curvan al más cercano a < 340, projectile.js update) = proyectil
 *   - bounce: fireProjectiles; al dar, rebound salta al más cercano NO tocado a < 220 px del golpeado, `bounce`
 *     veces, daño entero en cada uno (antes que la perforación)
 *   - charge: chargeUp → a los `charge` s, beam() (el rayo de siempre, con su grosor); recarga desde que se lanza
 *   - spin: campo que te sigue y da `count` golpes (cada 0,13 s) a todo lo que toca radius (tickNewField)
 *   - quake: `count` explosiones (cada 0,07 s) de radio `radius` a i·QSTEP (34 px) en línea hacia donde
 *     apuntas, desde donde estabas (quake / tickNewField / blast); una pared la corta
 *   - vortex: campo en el blanco (spotFor, < 300 px) que daña cada 0,4 s (el primero a 0,15 s) durante `dur`
 *     y atrae a `pull` px/s (jefes ×0,25) a los de < 1,4·radius; como mucho 2 a la vez por jugador (vortex)
 *   - shove: un golpe a todo lo de < radius alrededor y los aparta `knock` (shove)
 *   - stun: zona en el blanco (spotFor) que a los 0,45 s daña a todo lo de < radius y lo deja quieto `stun` s
 *     (jefes ×0,35); aturdido no se mueve, no dispara ni pega por contacto (stunZone, enemy.js applyStun /
 *     update, combat.js resolve)
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
 * Peligro (versión del 2026-10-16; simulate / dangerOf / addDanger, y el reflejo de autopilot.js):
 *   - cada golpe: daño · tipos · clima · (1 − defensa) · 0,75 con cuerpo a cuerpo (player.js:228-239);
 *     después, 0,45 s invulnerable (player.js:241): contactos y disparos, como mucho uno cada 0,45 s
 *   - contacto: cada enemigo como mucho cada 0,55 s, aunque estés invulnerable (combat.js:663-667)
 *   - avisos del suelo: quitan la invulnerabilidad al estallar, así que se suman (hazards.js:46-49)
 *   - bomber: a < radios + 26 px prende la mecha y estalla en 1 s, 62 px, daño ×1,4 (enemy.js:314, :639-641)
 *   - charger: a < 200 px apunta 0,55 s y embiste ×3,4 durante 0,42 s, luego 1,1 s andando (enemy.js:342-360)
 *   - los que guardan distancia: se apartan a < 0,62·alcance, disparan a < alcance cada shotCd (enemy.js:361-372);
 *     ranged un disparo, fan 3-5 en abanico al 65 %, beamer rayo con aviso de 1 s, zoner zona de 1,2 s
 *     (enemy.js:549-582); disparos a 190 px/s que paran las paredes (combat.js:559-566)
 *   - Banda Focus: el golpe que te dejaría KO te deja con 1 (cada 60 s) (player.js:248-251)
 *   - mareas: cada 38-56 s una avalancha desde un lado (spawner.js:137-146)
 *   - jefes: 'far' se aparta a < 170 px y rodea a < 300; 'close' persigue a ×1,1 (×1,25 enfurecido) (enemy.js:423-441)
 * Objetivos raros (versión del 2026-10-16; specialTactics):
 *   - duende del tesoro: 92 px/s, huye en zigzag (±0,7 rad) a todo correr a < 300 px, si no al 35 %
 *     (enemy.js:283-296); se va a los 15 s (events.js:23, enemy.js:920); no hace daño (combat.js:664);
 *     Meowth 20 monedas de 5, Gholdengo 6 de 5 y un ticket ×10 (enemy.js:181-186, game.js:490)
 *   - shiny: vida ×2, experiencia ×5 (enemy.js:84-90); es tuyo al caer, o +300 monedas si ya lo tenías
 *     (game.js:271-281); no se va nunca (enemy.js:927)
 *   - hora dorada: 30 s (events.js:22, :72-74); dorados = experiencia ×2 y 35 % de 3 monedas (enemy.js:93-96,
 *     :179); también los que salen durante (spawner.js:88)
 *   - Pokémon perdido: tocarlo, te sigue y a < 56 px de la marca se salva; enemigos encima le quitan
 *     min(30, Σ 4 + 0,12·daño) cada 0,5 s; 100 de vida; 120 s; premio: 50 % de tu vida, 12 monedas de 5,
 *     un ticket y 1 de cada 5 se une a ti (events.js:130-230, game.js:261-266)
 *   - grieta: golpe del legendario 36 + t/20 de contacto (rift.js:147), con su tipo más probable
 */
G.Tactics = (() => {
  const U = G.U;
  const NEAR = 460;                       // radio de lo que se tiene en cuenta
  const DIR8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const KEEPERS = ['ranged', 'fan', 'beamer', 'zoner', 'healer', 'summoner'];
  const r1 = v => Math.round(v * 10) / 10;
  const QSTEP = 34;                       // distancia entre ondas de un terremoto (combat.js QSTEP)

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
      case 'homing': case 'bounce': return Math.min(520, (m.speed || 300) * (m.life || 1.5));   // fireProjectiles
      case 'charge': return m.radius;                                  // beam()
      case 'spin': case 'shove': return m.radius;                      // + radio del enemigo (queryCircle)
      case 'quake': return (m.count | 0) * QSTEP + m.radius;           // la última onda
      case 'vortex': case 'stun': return 300;                          // se pone en el blanco (spotFor, reach)
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
      case 'homing': case 'bounce': return U.clamp(h * 0.42, 140, 230);   // como el proyectil
      case 'charge': return U.clamp(h * 0.7, 90, 220);                  // como el rayo
      case 'spin': case 'shove': return Math.max(30, m.radius * 0.6);   // como el aura: todo alrededor
      case 'quake': return U.clamp(h * 0.5, 60, 200);                   // el blanco a media línea de ondas
      case 'vortex': case 'stun': return 200;                           // caen sobre el blanco: no hace falta acercarse
      default: return 220;
    }
  }

  /** ¿Hace daño en área (puede dar a varios a la vez)? */
  const AREA = ['nova', 'cone', 'melee', 'beam', 'aura', 'boomerang', 'meteor', 'dash', 'orbit', 'mine', 'trail',
                'bounce', 'charge', 'spin', 'quake', 'vortex', 'shove', 'stun'];

  /** Tu velocidad fuera del agua (pl.spd ya trae el frenazo si estás dentro). */
  function drySpd(pl) {
    const w = (G.World.liquidEffect(pl.mon.types) || {}).slow || 1;
    return pl.inLiquid && w < 1 ? pl.spd / w : pl.spd;
  }

  const typeK = (type, e) => G.Types.mult(type, e.types) * G.Weather.mult(type);

  // ---------------- conocimiento: daño real de un movimiento (modelo geométrico) ----------------
  // Cuenta, con la posición de cada enemigo, cuántos golpes le da de verdad cada forma de atacar
  // (combat.js) y suma quemadura y veneno (enemy.js). Comprobado contra el juego (2026-10-18): banco
  // de pruebas con muñecos a 60/200/400 px, 10 repartidos en 250 px y 8 que te persiguen.
  const TARGETED = ['melee', 'beam', 'projectile', 'boomerang', 'chain', 'meteor', 'dash', 'cone',      // combat.js needsTarget
                    'homing', 'bounce', 'charge', 'spin', 'quake', 'vortex', 'shove', 'stun'];
  /** Distancia del blanco a la que se lanza (combat.js reach). */
  function reachOf(m) {
    switch (m.kind) {
      case 'melee': return m.radius + 30;
      case 'beam': return m.radius + 20;
      case 'boomerang': return m.radius + 40;
      case 'chain': return 280;
      case 'meteor': return 340;
      case 'dash': return m.radius + 60;
      case 'cone': return m.speed * m.life + 30;
      case 'spin': case 'shove': case 'charge': return m.radius + 20;
      case 'quake': return (m.count | 0) * QSTEP + m.radius;
      case 'vortex': case 'stun': return 300;
      default: return 520;
    }
  }
  const REF_R = 14, REF_HP = 100;            // enemigo de referencia cuando no hay uno concreto (radio y vida típicos)
  const TRAIL_ON = 0.3;                      // parte del tiempo que un perseguidor pisa tu rastro (medido, ver trail)
  const MINE_ON = 0.5;                       // parte de las minas que pisan los perseguidores (medido, ver mine)
  const angDiff = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const chases = e => !KEEPERS.includes(e.behavior) && (e.spd || 0) > 0;
  const castEvery = (pl, m) => Math.max(0.05, m.cd * pl.cdMul * (m.kind === 'buff' && pl.abil && pl.abil.statusCd || 1));   // combat.js tickMove

  /**
   * Proyectil recto desde (ox, oy): suma w a los `cap` primeros que pilla (colisión barrida, combat.js resolve).
   * jit: desvío al azar del ángulo (±rad), que a veces hace fallar o acertar por poco.
   */
  function ray(ox, oy, th, R, size, foes, cap, out, w, jit = 0, rangeP = null) {
    const c = Math.cos(th), s = Math.sin(th), on = [];
    for (let j = 0; j < foes.length; j++) {
      const f = foes[j], dx = f.x - ox, dy = f.y - oy;
      const al = dx * c + dy * s;
      if (al < -f.r || al - f.r > R) continue;
      const lat = Math.abs(dy * c - dx * s), half = f.r + size, sp = jit * Math.max(0, al);
      const p = sp > 0.5 ? U.clamp((Math.min(lat + sp, half) - Math.max(lat - sp, -half)) / (2 * sp), 0, 1) : lat <= half ? 1 : 0;
      if (p > 0) on.push([al, j, p]);
    }
    on.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < on.length && k < cap; k++) {
      const [al, j, p] = on[k];
      out[j] += w * p * (rangeP ? rangeP(al - foes[j].r) : 1);
    }
  }

  /** Teledirigido (projectile.js update): mayor desvío inicial (rad) con el que aún da a un blanco quieto a d px. */
  const homingMemo = new Map();
  function homingCapture(m, d, r) {
    const key = [m.speed, m.homing, m.life, m.size, Math.round(d / 8), Math.round(r)].join('|');
    if (homingMemo.has(key)) return homingMemo.get(key);
    const sp0 = m.speed || 220, life = m.life || 1.2, rr = (r + (m.size || 6)) ** 2, dt = 1 / 60;
    const hits = a => {
      let x = 0, y = 0, vx = Math.cos(a) * sp0, vy = Math.sin(a) * sp0;
      for (let t = 0; t < life; t += dt) {
        const tx = d - x, ty = -y, l = Math.hypot(tx, ty) || 1, sp = Math.hypot(vx, vy);
        if (l <= 340) { const k = Math.exp(-m.homing * dt); vx = tx / l * sp + (vx - tx / l * sp) * k; vy = ty / l * sp + (vy - ty / l * sp) * k; }
        x += vx * dt; y += vy * dt;
        if ((x - d) ** 2 + y * y <= rr) return true;
      }
      return false;
    };
    let lo = 0, hi = Math.PI;
    if (!hits(0)) lo = hi = 0;
    else if (hits(Math.PI)) lo = Math.PI;
    else for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (hits(mid)) lo = mid; else hi = mid; }
    if (homingMemo.size > 400) homingMemo.clear();
    homingMemo.set(key, lo);
    return lo;
  }

  /**
   * Golpes por segundo que da el movimiento m a cada enemigo de `foes` estando tú en (px, py) y
   * apuntando al más cercano (player.js update). → { w: golpes con su peso de daño, n: golpes (estados) }
   */
  function moveRates(pl, m, px, py, foes) {
    const N = foes.length, w = new Float64Array(N), n = new Float64Array(N);
    if (!N || !m.dmg) return { w, n };
    let ti = -1, td = Infinity;
    for (let j = 0; j < N; j++) { const d = Math.hypot(foes[j].x - px, foes[j].y - py); if (d < td) { td = d; ti = j; } }
    if (TARGETED.includes(m.kind) && td > reachOf(m)) return { w, n };      // no se lanza sin blanco a tiro
    const tg = foes[ti], a0 = Math.atan2(tg.y - py, tg.x - px);
    const cnt = Math.max(1, m.count | 0), per = 1 / castEvery(pl, m);
    const dist = f => Math.hypot(f.x - px, f.y - py);
    const add = (j, k, hits = k) => { w[j] += k; n[j] += hits; };
    switch (m.kind) {
      case 'projectile': case 'homing': {   // combat.js fireProjectiles: abanico de `count`, perforación (homing: run → fireProjectiles con m.homing)
        const R = Math.min(520, (m.speed || 300) * (m.life || 1.5)), sp = m.spread || 0;
        for (let i = 0; i < cnt; i++) {
          const off = cnt === 1 || m.homing ? 0 : (i / (cnt - 1) - 0.5) * sp * cnt;   // teledirigido: va al más cercano
          ray(px, py, a0 + off, R, m.size || 6, foes, (m.pierce | 0) + 1, w, per, 0.03);
        }
        n.set(w); return { w, n };
      }
      case 'nova': {                        // combat.js nova: `count` (≥3) en círculo; cada uno se para en el primero (o perfora)
        const k = Math.max(3, m.count | 0), R = (m.speed || 220) * (m.life || 1.2), s = m.size || 6, cap = (m.pierce | 0) + 1;
        const iv = [];
        for (let j = 0; j < N; j++) {
          const f = foes[j], d = dist(f);
          if (d - f.r > R) continue;
          let half = d <= f.r + s ? Math.PI : Math.asin((f.r + s) / d);
          if (m.homing && j === ti) half = Math.max(half, homingCapture(m, d, f.r));   // se curvan hacia él
          iv.push([Math.atan2(f.y - py, f.x - px), half, d, j]);
        }
        if (!iv.length) return { w, n };
        iv.sort((a, b) => a[2] - b[2]);
        const S = 240, step = per * k / S;
        for (let i = 0; i < S; i++) {
          const th = i / S * 6.2832;
          let c = 0;
          for (const v of iv) if (angDiff(th, v[0]) <= v[1]) { add(v[3], step); if (++c >= cap) break; }
        }
        return { w, n };
      }
      case 'cone': {                        // combat.js cone: abanico `arc`, alcance speed·life ×0,85–1,1 ×0,85–1,05
        const k = Math.max(2, m.count | 0), arc = m.arc || 0.9, R = m.speed * m.life;
        const rangeP = x => U.clamp((1.155 - x / R) / 0.4325, 0, 1);
        for (let i = 0; i < k; i++) ray(px, py, a0 + (i / (k - 1) - 0.5) * arc, R * 1.155, m.size || 6, foes, (m.pierce | 0) + 1, w, per, 0.05, rangeP);
        n.set(w); return { w, n };
      }
      case 'melee': {                       // combat.js melee: arco `arc` de radio `radius`
        const half = Math.min(m.arc, 6.2832) / 2;
        for (let j = 0; j < N; j++) {
          const f = foes[j];
          if (dist(f) <= m.radius + f.r && angDiff(Math.atan2(f.y - py, f.x - px), a0) <= half) add(j, per);
        }
        return { w, n };
      }
      case 'beam': case 'charge': case 'dash': {   // combat.js beam (franja) / dash (cápsula: segDist2): recto, largo `radius`
        // charge: chargeUp → a los `charge` s llama a beam() (tickNewField); la recarga corre desde el lanzamiento,
        // así que da los mismos golpes por segundo. No se cuenta lo que se mueve el blanco durante la carga.
        const half = (m.width || 34) / 2, c = Math.cos(a0), s = Math.sin(a0), L = m.radius;
        for (let j = 0; j < N; j++) {
          const f = foes[j], dx = f.x - px, dy = f.y - py, al = dx * c + dy * s, lat = Math.abs(dy * c - dx * s);
          const hit = m.kind !== 'dash' ? al >= -f.r && al <= L + f.r && lat <= half + f.r
            : Math.hypot(Math.max(0, al - L, -al), lat) <= half + f.r;
          if (hit) add(j, per);
        }
        return { w, n };
      }
      case 'aura': {                        // combat.js aura: todo lo que toca el círculo
        for (let j = 0; j < N; j++) if (dist(foes[j]) <= m.radius + foes[j].r) add(j, per);
        return { w, n };
      }
      case 'spin': case 'shove': {          // combat.js spin + tickNewField: `count` golpes (cada 0,13 s) a < radius; shove: uno
        // shove además aparta `knock` px (no a los jefes): eso es control, no daño; aquí sólo cuenta el golpe.
        const k = m.kind === 'spin' ? cnt : 1;
        for (let j = 0; j < N; j++) if (dist(foes[j]) <= m.radius + foes[j].r) add(j, per * k);
        return { w, n };
      }
      case 'quake': {                       // combat.js quake + tickNewField: ondas i = 1..count a i·QSTEP en línea, blast de radio `radius`
        const c = Math.cos(a0), s = Math.sin(a0);
        for (let i = 1; i <= cnt; i++) {
          const cx = px + c * i * QSTEP, cy = py + s * i * QSTEP;
          for (let j = 0; j < N; j++) if (Math.hypot(foes[j].x - cx, foes[j].y - cy) <= m.radius + foes[j].r) add(j, per);
        }
        return { w, n };
      }
      case 'vortex': {                      // combat.js vortex + tickNewField: en el blanco, blast cada 0,4 s (el 1.º a 0,15 s) durante `dur`
        // Como mucho 2 a la vez (se quitan los viejos): cada uno vive min(dur, 2 · recarga).
        const life = Math.min(m.dur || 2.6, 2 * castEvery(pl, m));
        const ticks = life > 0.15 ? 1 + Math.floor((life - 0.15) / 0.4) : 0;
        const R = m.radius, pull = m.pull || 140, cx = tg.x, cy = tg.y;
        for (let j = 0; j < N; j++) {
          const f = foes[j], d = Math.hypot(f.x - cx, f.y - cy);
          if (d > R * 1.4 + f.r) continue;                     // fuera de lo que atrae (queryCircle f.r · 1.4)
          // Atrae a `pull` px/s (jefes ×0,25): si puede con su velocidad, se queda dentro todo el rato; si no
          // (un jefe), sale andando hacia ti en (R + su radio) / velocidad. Los de la corona entre R y 1,4·R
          // tardan en entrar: se pierden el primer golpe.
          const pk = pull * (f.boss ? 0.25 : 1), held = pk >= (f.spd || 0);
          const stay = held ? life : Math.min(life, (R + f.r) / Math.max(1, f.spd - pk));
          let k = stay > 0.15 ? 1 + Math.floor((stay - 0.15) / 0.4) : 0;
          if (d > R + f.r) k = Math.max(0, k - 1);
          if (k) add(j, per * Math.min(k, ticks));
        }
        // Control (que no se te acerquen mientras dura) no se cuenta como daño.
        return { w, n };
      }
      case 'stun': {                        // combat.js stunZone + tickNewField: en el blanco, a los 0,45 s, un golpe a todo lo de < radius
        // Se calcula donde está el blanco ahora (en 0,45 s un perseguidor a 60 px/s se mueve ~27 px; el radio es ~56).
        // El aturdimiento (`stun` s quieto, sin pegar ni disparar) no se pasa a daño: lo ve simulate con e.stunT.
        for (let j = 0; j < N; j++) if (Math.hypot(foes[j].x - tg.x, foes[j].y - tg.y) <= m.radius + foes[j].r) add(j, per);
        return { w, n };
      }
      case 'bounce': {                      // combat.js fireProjectiles + rebound: da al primero y salta `bounce` veces
        // Primer golpe: recto como un proyectil (abanico si count > 1). Cada rebote va al más cercano aún no tocado
        // a < 220 px del que acaba de golpear, con todo el daño. No se cuenta a quien se cruce en el camino del rebote.
        const R = Math.min(520, (m.speed || 300) * (m.life || 1.5)), sp = m.spread || 0, nb = m.bounce | 0;
        for (let i = 0; i < cnt; i++) {
          const off = cnt === 1 ? 0 : (i / (cnt - 1) - 0.5) * sp * cnt;
          const first = new Float64Array(N);
          ray(px, py, a0 + off, R, m.size || 6, foes, 1, first, 1, 0.03);
          for (let j0 = 0; j0 < N; j0++) {
            if (!first[j0]) continue;
            const pw = per * first[j0], done = new Set([j0]);
            let cur = j0;
            add(j0, pw);
            for (let b = 0; b < nb; b++) {
              let best = -1, bd = 220 * 220;
              for (let j = 0; j < N; j++) {
                if (done.has(j)) continue;
                const d2 = (foes[j].x - foes[cur].x) ** 2 + (foes[j].y - foes[cur].y) ** 2;
                if (d2 < bd) { bd = d2; best = j; }
              }
              if (best < 0) break;
              done.add(best); add(best, pw); cur = best;
            }
          }
        }
        return { w, n };
      }
      case 'boomerang': {                   // combat.js boomerang: va `radius` y vuelve; golpea a la ida y a la vuelta
        const sp = m.spread || 0.5;
        for (let i = 0; i < cnt; i++) {
          const off = cnt === 1 ? 0 : (i / (cnt - 1) - 0.5) * sp * Math.min(cnt, 3);
          ray(px, py, a0 + off, m.radius, m.size || 6, foes, 999, w, 2 * per);
        }
        n.set(w); return { w, n };
      }
      case 'chain': {                       // combat.js chain: salta al más cercano a < radius, cada salto ×0,85
        let cur = ti, k = 1;
        const done = new Set();
        for (let i = 0; i < cnt && cur >= 0; i++) {
          done.add(cur);
          const f = foes[cur];
          const hex = m.hex && (f.burn > 0 || f.poison > 0 || f.slow > 0) ? m.hex : 1;
          add(cur, per * k * hex, per);
          k *= 0.85;
          let best = -1, bd = m.radius * m.radius;
          for (let j = 0; j < N; j++) {
            if (done.has(j)) continue;
            const d2 = (foes[j].x - f.x) ** 2 + (foes[j].y - f.y) ** 2;
            if (d2 < bd) { bd = d2; best = j; }
          }
          cur = best;
        }
        return { w, n };
      }
      case 'meteor': {                      // combat.js meteors: uno por enemigo a < 340 (al azar); los que sobran, al azar
        const near = [];
        for (let j = 0; j < N; j++) if (dist(foes[j]) <= 340 + foes[j].r) near.push(j);
        const R = m.radius, pick = Math.min(1, cnt / near.length), extra = Math.max(0, cnt - near.length);
        for (const j of near) {
          for (let k = 0; k < N; k++) {
            if (Math.hypot(foes[k].x - foes[j].x, foes[k].y - foes[j].y) <= R + foes[k].r) add(k, per * pick);
          }
        }
        if (extra) for (let k = 0; k < N; k++) {        // caen en un rectángulo de 280 × 220 a tu alrededor
          const f = foes[k], rr = (R + f.r) ** 2;
          if (Math.abs(f.x - px) > 140 + R + f.r || Math.abs(f.y - py) > 110 + R + f.r) continue;
          let inA = 0;
          for (let gx = -130; gx <= 130; gx += 20) for (let gy = -100; gy <= 100; gy += 20) if ((px + gx - f.x) ** 2 + (py + gy - f.y) ** 2 <= rr) inA++;
          add(k, per * extra * inA / 154);
        }
        return { w, n };
      }
      case 'turret': {                      // combat.js turret + updateFields: dispara cada `rate` al más cercano a < range
        const life = Math.min(m.dur || 6, cnt * castEvery(pl, m));   // la nueva sustituye a la más vieja
        const shots = life > 0.3 ? (1 + Math.floor((life - 0.3) / (m.rate || 0.6))) * per : 0;
        const ox = px - Math.cos(a0) * 24, oy = py - Math.sin(a0) * 24;     // se queda detrás de ti
        let bj = -1, bd = (m.range || 300) ** 2;
        for (let j = 0; j < N; j++) { const d2 = (foes[j].x - ox) ** 2 + (foes[j].y - oy) ** 2; if (d2 < bd) { bd = d2; bj = j; } }
        if (bj >= 0) ray(ox, oy, Math.atan2(foes[bj].y - oy, foes[bj].x - ox), (m.speed || 300) * 1.4, m.size || 6, foes, (m.pierce | 0) + 1, w, shots);
        n.set(w); return { w, n };
      }
      case 'mine': {                        // combat.js mines + updateFields: estallan si un enemigo pasa a < 14 px (+ su radio) ya armadas
        const R = m.radius, ch = [];
        for (let j = 0; j < N; j++) if (chases(foes[j]) && dist(foes[j]) < 300) ch.push(j);
        if (ch.length) {
          // Te persiguen y las pisan: cada mina, a quien la pisa y a los de al lado. No todas: se quitan las
          // viejas al pasar de 4 + 2·count, y frenados (string-shot) llegan a menos. Parte pisada medida
          // con 8 perseguidores (banco de pruebas 2026-10-18): MINE_ON · (1 − frenado).
          const each = cnt * per * MINE_ON * (1 - (m.slow || 0)) / ch.length;
          for (const j of ch) for (let k = 0; k < N; k++) {
            if (Math.hypot(foes[k].x - foes[j].x, foes[k].y - foes[j].y) <= R + foes[k].r) add(k, each);
          }
        } else {
          // Quietos: se ponen a tu lado (a 18–46 px si son varias) y estalla la que cae junto a uno; las demás
          // se quitan al pasar de 4 + 2·count o, si duran menos que eso, estallan solas a la mitad.
          const expire = (4 + cnt * 2) / cnt * castEvery(pl, m) > (m.dur || 7);
          const spots = [];
          if (cnt === 1) spots.push([px, py]);
          else for (let a = 0; a < 16; a++) for (const rr of [21.5, 28.5, 35.5, 42.5]) spots.push([px + Math.cos(a / 16 * 6.2832) * rr, py + Math.sin(a / 16 * 6.2832) * rr * 0.8]);
          const each = cnt * per / spots.length;
          for (const [x, y] of spots) {
            let trig = -1;
            for (let j = 0; j < N; j++) if (Math.hypot(foes[j].x - x, foes[j].y - y) <= 14 + foes[j].r) { trig = j; break; }
            const k0 = trig >= 0 ? 1 : expire ? 0.5 : 0;
            if (!k0) continue;
            for (let k = 0; k < N; k++) if (Math.hypot(foes[k].x - x, foes[k].y - y) <= R + foes[k].r) add(k, each * k0, each);
          }
        }
        return { w, n };
      }
      case 'trail': {                       // combat.js trailPatch: charcos de radio `radius` que dañan cada 0,5 s durante `dur`
        const R = m.radius, life = m.dur || 3;
        const gap = Math.max(R * 0.9, drySpd(pl) * castEvery(pl, m));    // corriendo: un charco cada `gap` px
        for (let j = 0; j < N; j++) {
          const f = foes[j];
          if (chases(f) && dist(f) < 250) add(j, 2 * TRAIL_ON * Math.min(18, life / castEvery(pl, m), 2 * (R + f.r) / gap));
          else if (dist(f) <= R + f.r) add(j, 2 * life / Math.max(1, Math.ceil(1 / castEvery(pl, m)) * castEvery(pl, m)));   // quieto: uno por segundo
        }
        return { w, n };
      }
      case 'orbit': {                       // combat.js orbit: elipse radius × 0,7·radius, gira `speed` rad/s; cada orbe vuelve a dar cada max(0,12, cd)
        const a = m.radius, b = a * 0.7, ws = m.speed || 2, rh = Math.max(0.12, m.cd), s = m.size || 8, S = 72;
        for (let j = 0; j < N; j++) {
          const f = foes[j], dx = f.x - px, dy = f.y - py, rr = (s + f.r) ** 2;
          let inside = 0;
          for (let i = 0; i < S; i++) { const t = i / S * 6.2832; if ((a * Math.cos(t) - dx) ** 2 + (b * Math.sin(t) - dy) ** 2 <= rr) inside++; }
          if (!inside) continue;
          const tov = inside / S * 6.2832 / ws;                  // segundos encima en cada pasada
          add(j, cnt * ws / 6.2832 * (1 + Math.floor(tov / rh)));
        }
        return { w, n };
      }
    }
    return { w, n };
  }

  /** Pilas medias de quemadura/veneno en `H` s: `a` pilas/s en `hr` golpes/s, tope 8, se pierden a los `last` s (enemy.js:146-153). */
  function avgStacks(a, hr, last, H) {
    if (a <= 0 || hr <= 0) return 0;
    if (1 / hr > last) return Math.min(8, a / hr) * last * hr;
    const tr = 8 / a;
    return H <= tr ? a * H / 2 : 8 * (1 - tr / (2 * H));
  }

  /**
   * Daño por segundo de unos movimientos (un hueco) a cada enemigo de `foes` desde (px, py):
   * golpes · dmg · atkFor · defensa del enemigo · tipos · clima · crítico, más quemadura (1,6 · pilas · (1 + 0,06·nivel) cada 0,5 s)
   * y veneno (1,2 % de la vida máxima · pilas + 1 cada 0,6 s) (enemy.js:255-263, combat.js hit).
   * o.prop: contra un objeto (sin tipos, crítico ni estados: world.js damageProp). → { total, per }
   */
  function dpsOn(pl, moves, px, py, foes, o = {}) {
    const N = foes.length, per = new Float64Array(N), burnA = new Float64Array(N), burnH = new Float64Array(N);
    const poisA = new Float64Array(N), poisH = new Float64Array(N);
    const ab = pl.abil || {};
    const crit = 1 + (pl.critChance || 0) * ((ab.critMul || 1.5) - 1);
    const sk = ab.sheer ? 0 : ab.serene ? 2 : 1;                         // combat.js statusK
    for (const m of moves) {
      if (!m.dmg) continue;
      const r = moveRates(pl, m, px, py, foes);
      for (let j = 0; j < N; j++) {
        if (!r.w[j]) continue;
        const out = !o.prop && ab.out ? ab.out(pl, m, foes[j]) : 1;   // combat.js abilOut
        per[j] += r.w[j] * m.dmg * pl.atkFor(m) * (o.prop ? 1 : typeK(m.type, foes[j]) * G.Stats.taken(foes[j].mon, m.cat) * crit * out);
        if (m.burn && sk) { burnA[j] += r.n[j] * m.burn * sk; burnH[j] += r.n[j]; }
        if (m.poison && sk) { poisA[j] += r.n[j] * m.poison * sk; poisH[j] += r.n[j]; }
      }
    }
    let total = 0;
    for (let j = 0; j < N; j++) {
      if (!o.prop && (burnA[j] || poisA[j])) {
        const f = foes[j];
        // Horizonte: lo que tarda en caer con el golpe directo (los estados tardan en acumularse), máx. 15 s.
        const H = o.H || U.clamp((f.hp || REF_HP) / Math.max(1, per[j]), 1, 15);
        per[j] += 3.2 * (1 + 0.06 * (pl.level || 1)) * avgStacks(burnA[j], burnH[j], 3, H);
        const ps = avgStacks(poisA[j], poisH[j], 4, H);
        if (ps) per[j] += (0.012 * (f.maxHp || REF_HP) * ps + Math.min(1, 4 * poisH[j])) / 0.6;
      }
      total += per[j];
    }
    return { total, per };
  }

  /** Un enemigo (o el de referencia) puesto a `d` px delante de ti, para el modelo. */
  const proxy = (e, d) => ({ x: d, y: 0, r: e ? e.r || REF_R : REF_R, hp: e ? e.hp : REF_HP, maxHp: e ? e.maxHp : REF_HP,
    types: e ? e.types : null, mon: e ? e.mon : null, behavior: e ? e.behavior : 'chase', spd: e ? e.spd || 0 : 60, boss: !!(e && e.boss), burn: e && e.burn, poison: e && e.poison, slow: e && e.slow });

  /** 10 enemigos de referencia repartidos en 250 px que te persiguen (como el banco de pruebas). */
  const REF_GROUP = Array.from({ length: 10 }, (_, i) => ({ x: Math.cos(i * 2.39996) * (60 + 19 * i), y: Math.sin(i * 2.39996) * (60 + 19 * i),
    r: REF_R, hp: REF_HP, maxHp: REF_HP, types: null, behavior: 'chase', spd: 60 }));
  /** Daño por segundo de referencia de un movimiento: a un blanco y a un grupo de 10 (para las cartas y Jev). */
  function refDps(pl, m) {
    if (!m || !m.dmg || m.kind === 'buff') return { one: 0, group: 0 };
    return { one: moveDps(pl, m, null), group: dpsOn(pl, [m], 0, 0, REF_GROUP).total };
  }

  // Distancias al blanco que se prueban: la de combate y más cerca, hasta tocarse (los que te persiguen
  // llegan a tu lado: radios sumados, combat.js resolve). Hace falta: un abanico par (Ascuas nv. 2–4: ±spread)
  // deja un hueco en el centro y a 200 px no le da a uno solo (medido); dos hojas/huesos (bumerán ±spread,
  // combat.js:212-224) sólo le dan a uno pegado a ti.
  const TRY_D = (m, touch) => [engageDist(m), 120, 60, touch];

  /** Daño por segundo de un movimiento contra un enemigo, a la mejor de esas distancias. */
  function moveDps(pl, m, e) {
    if (!m.dmg || m.kind === 'buff') return 0;
    let best = 0;
    for (const d of TRY_D(m, (pl.r || 16) + (e && e.r || REF_R))) best = Math.max(best, dpsOn(pl, [m], 0, 0, [proxy(e, d)]).total);
    return best;
  }

  // ---------------- conocimiento: enemigos ----------------

  /** Amenaza de un enemigo: daño por segundo que te puede hacer y si lo puedes dejar atrás. */
  function threatOf(pl, e) {
    const tk = G.Types.mult(e.atkType, pl.mon.types) * G.Stats.taken(pl.mon, e.cat);   // tipo y tu Defensa / Def. Esp.
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

    // Huecos: daño por segundo al grupo de alrededor (los de < 250 px; si no hay, el más cercano),
    // colocándote a su distancia de combate del más cercano (lo que hará la táctica de pelear).
    const group = enemies.filter(x => x.d <= 250);
    if (!group.length && enemies.length) group.push(enemies[0]);
    const foes = group.map(x => x.e);
    const slots = pl.slots.map((g, i) => {
      let kSum = 0, wsum = 0;
      const main = g[0];
      for (const x of enemies) { const w = 1 / (1 + x.d / 180); kSum += (main ? typeK(main.type, x.e) * G.Stats.taken(x.e.mon, main.cat) : 1) * w; wsum += w; }
      // baseDps: ¿hace daño? (a uno; si a uno no le da, como Hoja Afilada con 2 hojas, a un grupo).
      let base = 0;
      for (const m of g) { const r = refDps(pl, m); base += r.one || r.group / 10; }
      let dps = base, keep = main ? engageDist(main) : 220;
      if (foes.length && main) {
        // Desde la distancia de combate del más cercano o más cerca (los enemigos se te acercan): la mejor.
        // Ponerse más cerca a propósito sólo si a la distancia de combate casi no le das (< 25 % de lo mejor,
        // p. ej. Hoja Afilada con 2 hojas: sólo da pegado). Acercarse siempre que diera algo más se probó el
        // 2026-10-18 y la supervivencia en kite bajó.
        const tg = group[0];
        const tries = TRY_D(main, (pl.r || 16) + (tg.e.r || REF_R)).map(d => {
          const k = tg.d > d ? (tg.d - d) / tg.d : 0;
          return [d, dpsOn(pl, g, pl.x + (tg.e.x - pl.x) * k, pl.y + (tg.e.y - pl.y) * k, foes).total];
        });
        dps = Math.max(...tries.map(t => t[1]));
        // (la más lejana que da ≥ 75 % de lo mejor: cuanto más lejos, menos golpes recibes)
        if (tries[0][1] < dps * 0.25) keep = tries.filter(t => t[1] >= dps * 0.75).sort((a, b) => b[0] - a[0])[0][0];
      }
      const area = g.some(m => AREA.includes(m.kind));
      return {
        index: i, moves: g, main,
        dps, baseDps: base, typeK: wsum ? kSum / wsum : 1, area,
        range: main ? hitRange(main) : 0, keep,
        // De cerca (hay que meterse entre ellos): también giro y empujón, que sólo dan a < radius de ti (combat.js spin / shove).
        melee: g.some(m => m.kind === 'melee' || m.kind === 'aura' || m.kind === 'orbit' || m.kind === 'spin' || m.kind === 'shove'),
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
  // Dan al objeto si se le apunta (necesitan blanco, y el blanco puede ser la roca/cofre: player.js update).
  // Familias del 19-10-2026: homing/bounce chocan como proyectiles (combat.js resolve), charge es beam(),
  // spin/shove dañan propsInCircle a tu alrededor y quake hace blast() en cada onda. vortex y stun no: van a
  // spotFor, que sólo acepta enemigos (t.hurt); sin enemigo, stunZone no sale y vortex cae a 120 px delante.
  const PROP_AIMED = ['projectile', 'melee', 'beam', 'boomerang', 'cone', 'dash', 'homing', 'bounce', 'charge', 'spin', 'shove', 'quake'];
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

  /** A qué distancia del objeto te pones para darle con m (orbitSpot / standSpot / dentro del aura). */
  function propDist(pl, m, p) {
    if (m.kind === 'orbit') return m.radius;
    if (m.kind === 'aura') return m.radius * 0.5;
    const hi = propBand(m, p)[1], minD = pl.r + p.r + 4;
    return BALLISTIC.includes(m.kind) ? Math.max(minD, Math.min(hi, 150) * 0.75) : Math.max(minD, hi - 14);
  }

  /** Daño por segundo de un hueco contra el objeto p (sin tipos, clima, crítico ni estados). aimFree: el apuntado va al objeto. */
  function propDps(pl, slot, aimFree, p) {
    let v = 0, best = null, bv = 0;
    for (const m of slot.moves) {
      if (!m.dmg || !(PROP_ALWAYS.includes(m.kind) || (aimFree && PROP_AIMED.includes(m.kind)))) continue;
      const x = dpsOn(pl, [m], 0, 0, [{ x: propDist(pl, m, p), y: 0, r: p.r, hp: p.hp, maxHp: p.hp }], { prop: true }).total;
      v += x;
      if (x > bv) { bv = x; best = m; }
    }
    return { dps: v, move: best };
  }

  /** Distancias (desde el centro del objeto) entre las que el movimiento le da. */
  function propBand(m, p) {
    switch (m.kind) {
      case 'melee': case 'aura': case 'spin': case 'shove': return [0, m.radius + p.r - 6];
      case 'orbit': return [Math.max(0, m.radius - p.r - (m.size || 8) + 4), m.radius + p.r + (m.size || 8) - 4];
      case 'beam': case 'charge': case 'dash': return [0, m.radius * 0.8];
      default: return [0, Math.min(170, hitRange(m) * 0.8)];
    }
  }

  const BALLISTIC = ['projectile', 'boomerang', 'cone', 'nova', 'homing', 'bounce'];   // vuelan: un árbol o una pared en medio se los come
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
    legCache = G.DEX.filter(p => p.leg && G.SPRITE_META[p.dex]).map(p => ({ types: p.types, cat: G.Stats.sideOf(p), w: beaten[p.dex] ? 1 : 4 }));
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

  // ---------------- peligro: el daño que te van a hacer (simulación con las reglas) ----------------
  // Se simulan unos segundos (paso de 0,1 s): tú sigues el camino de la táctica y cada enemigo hace lo
  // que dicen sus reglas (persigue, embiste, se aparta y dispara, prende la mecha...). El daño pasa por
  // las mismas cuentas que player.js hurt (tipos, clima, defensa, −25 % con cuerpo a cuerpo) y por la
  // invulnerabilidad de 0,45 s tras cada golpe (contactos y disparos); los avisos del suelo la saltan.
  // Mientras, tu hueco va tumbando al más cercano a tiro (su daño por segundo). Simplificaciones: los
  // enemigos van en línea recta (sin rodear paredes: lo prudente); los jefes cuentan por contacto (según
  // su modo 'far'/'close'), por sus disparos ya en el aire y por sus avisos ya en el suelo.
  const INVULN = 0.45, TOUCH_CD = 0.55, SIM_DT = 0.1, SIM_H = 3, SHOT_SPD = 190;
  const SHOOTERS = ['ranged', 'fan', 'beamer', 'zoner'];

  /** Lo que te quita un golpe (player.js hurt); cat: físico o especial, se para con tu Defensa o Def. Esp. */
  function taken(pl, amount, type, pure, cat) {
    let a = amount;
    if (type) a *= G.Types.mult(type, pl.mon.types) * G.Weather.mult(type);
    if (pure) return Math.max(1, a);
    const ab = pl.abil, cls = cat === 'physical' ? 'p' : cat === 'special' ? 's' : '';
    if (ab) {
      if (type && ab.absorb === type) return 0;                           // le cura (player.js hurt)
      if (ab.dodge) a *= 1 - U.clamp(ab.dodge(pl, type, cls), 0, 1);       // esquiva: de media
      if (ab.inMul) a *= ab.inMul(pl, type, cls);
    }
    a *= G.Stats.taken(pl.mon, cat);
    const close = pl.activeGroup().some(m => m.kind === 'melee') ? 0.75 : 1;
    return Math.max(1, a * (1 - pl.reduction) * close);
  }

  /** Cuándo choca un disparo con una pared o un objeto sólido (combat.js resolve). */
  function shotStop(x, y, vx, vy, r, H) {
    for (let t = SIM_DT; t <= H + 1e-6; t += SIM_DT) if (G.World.projectileBlock(x + vx * t, y + vy * t, r)) return t;
    return Infinity;
  }

  /** Foto de todo lo que puede hacerte daño (una vez por facts). */
  function simBase(pl, F) {
    if (F._sim) return F._sim;
    const foes = [];
    for (const x of F.enemies) {
      const e = x.e;
      if (x.d > 560 && !e.boss) continue;
      const shot = e.def && e.def.shotCd ? e.shotDmg() : (e.def && e.def.shotDmg) || 10;
      foes.push({
        id: e.id, x: e.x, y: e.y, r: e.r || 10, hp: e.hp, boss: !!e.boss,
        es: Math.max(10, e.spd * (1 - (e.slow || 0)) * G.Weather.speedFor(e.types)),
        hit: taken(pl, e.dmg, e.atkType, false, e.cat), raw: e.dmg, type: e.atkType, cat: e.cat, beh: e.behavior,
        keeper: KEEPERS.includes(e.behavior) && !e.boss,
        range: (e.def && e.def.range) || 200, shotCd: (e.def && e.def.shotCd) || 2, shotT: e.shotCd || 0, shot,
        fanN: (e.def && e.def.fanN) || 5,
        phase: e.phase, pt: e.pt || 0, dx: e.dx || 0, dy: e.dy || 0, touch: e.touchCd || 0,
        fuse: e.behavior === 'bomber' && e.phase === 'fuse',
        stun: e.stunT > 0 ? e.stunT : 0,       // aturdido: quieto, sin disparar ni pegar (enemy.js update, combat.js resolve)
        // Jefe (enemy.js:423-441): 'far' se aparta a < 170 px y te rodea a < 300; 'close' va a por ti a ×1,1
        // (×1,25 enfurecido); mientras lanza un ataque se queda quieto (sus avisos ya están en el suelo).
        bossMode: e.boss ? (e.ai && e.ai.cast ? 'cast' : e.ai ? e.ai.mode : 'close') : null, fury: e.ai && e.ai.fury ? 1.25 : 1
      });
    }
    const shots = [];
    for (const s of G.Projectiles.all()) {
      if (s.friendly || s.dead || (s.x - pl.x) ** 2 + (s.y - pl.y) ** 2 > 520 * 520) continue;
      shots.push({ x: s.x, y: s.y, vx: s.vx || 0, vy: s.vy || 0, r: s.r || 7, t0: 0, hit: taken(pl, s.dmg || 10, s.mtype, false, s.cat), stop: shotStop(s.x, s.y, s.vx || 0, s.vy || 0, s.r || 7, SIM_H) });
    }
    const zones = [];
    for (const h of (G.Hazards ? G.Hazards.all : [])) {
      if (h.hit) continue;
      const at = Math.max(0, h.delay - h.t);
      if (at > SIM_H) continue;
      zones.push({ h, at, hit: taken(pl, h.pct ? Math.max(h.dmg, pl.maxHp * h.pct) : h.dmg, h.type, !!h.pure, h.cat) });
    }
    return (F._sim = { foes, shots, zones });
  }

  /**
   * Simula H s. spec: { at(x, y, foes, thief) -> punto al que vas o null (quieto), within, arriveSafe,
   * dps, range (tu hueco), thief }. Devuelve { dmg, dmg2, ko, cum[] } (daño a los 3 s, a los 2 s,
   * segundos hasta el KO o null, daño acumulado por paso).
   */
  function simulate(pl, F, spec = {}, H = SIM_H) {
    const B = simBase(pl, F);
    const foes = B.foes.map(f => ({ ...f }));
    const byId = new Map(foes.map(f => [f.id, f]));
    const shots = B.shots.map(s => ({ ...s }));
    const zones = B.zones.map(z => ({ ...z }));
    const thief = spec.thief ? { ...spec.thief } : null;
    const spd = Math.max(30, drySpd(pl)), wSlow = (G.World.liquidEffect(pl.mon.types) || {}).slow || 1, rFree = Math.max(8, pl.r * 0.8);
    let px = pl.x, py = pl.y, hp = pl.hp, inv = Math.max(0, pl.invuln || 0);
    let sash = pl.hasItem('focussash') && performance.now() - (pl.sashT || -1e9) > 60000;
    let dmg = 0, dmg2 = 0, ko = null, safe = false;
    const cum = [];
    const hurt = (amt, t, pure) => {
      if (!pure && t < inv) return;
      dmg += amt; hp -= amt; inv = t + INVULN;
      if (hp <= 0) { if (sash) { sash = false; hp = 1; inv = t + 1.2; } else if (ko == null) ko = Math.round(t * 10) / 10; }
    };
    const fire = (f, ux, uy, t) => {
      if (f.beh === 'beamer') zones.push({ h: { kind: 'beam', x: f.x, y: f.y, angle: Math.atan2(uy, ux), len: 360, w: 22 }, at: t + 1.0, hit: taken(pl, f.shot * 1.05, f.type, false, f.cat) });
      else if (f.beh === 'zoner') zones.push({ h: { kind: 'zone', x: px, y: py, r: 44 }, at: t + 1.2, hit: taken(pl, f.shot * 0.95, f.type, false, f.cat) });
      else {
        const n = f.beh === 'fan' ? f.fanN : 1, spread = n === 3 ? 0.6 : 0.9, k = f.beh === 'fan' ? 0.65 : 1, base = Math.atan2(uy, ux);
        for (let i = 0; i < n; i++) {
          const a = base + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread), vx = Math.cos(a) * SHOT_SPD, vy = Math.sin(a) * SHOT_SPD;
          shots.push({ x: f.x, y: f.y, vx, vy, r: 7, t0: t, hit: taken(pl, f.shot * k, f.type, false, f.cat), stop: t + shotStop(f.x, f.y, vx, vy, 7, Math.max(0.1, H - t)) });
        }
      }
    };
    for (let t = SIM_DT; t <= H + 1e-6; t += SIM_DT) {
      // Tú.
      const goal = spec.at ? spec.at(px, py, byId, thief) : null;
      if (goal) {
        const d = Math.hypot(goal[0] - px, goal[1] - py);
        if (d > (spec.within || 4)) {
          const v = spd * (wSlow < 1 && G.World.isLiquid(px, py) ? wSlow : 1) * SIM_DT, k = Math.min(1, v / d);
          const nx = px + (goal[0] - px) * k, ny = py + (goal[1] - py) * k;
          if (G.World.isFree(nx, ny, rFree)) { px = nx; py = ny; }
        } else if (spec.arriveSafe) safe = true;
      }
      if (safe) { while (cum.length < Math.round(H / SIM_DT)) cum.push(dmg); break; }
      if (thief) {
        const dx = thief.x - px, dy = thief.y - py, d = Math.hypot(dx, dy) || 1, v = thief.es * (d < 300 ? 1 : 0.35) * 0.88 * SIM_DT;
        thief.x += dx / d * v; thief.y += dy / d * v;
      }
      // Ellos.
      const touching = [];
      for (const f of foes) {
        if (f.dead) continue;
        f.touch -= SIM_DT;
        if (f.stun > 0) { f.stun -= SIM_DT; continue; }                         // Onda Trueno, Tumba Rocas... (stunZone)
        const dx = px - f.x, dy = py - f.y, d = Math.hypot(dx, dy) || 1;
        if (f.fuse) { if ((f.pt -= SIM_DT) <= 0) f.dead = true; continue; }       // su aviso ya está en el suelo
        if (f.keeper) {
          const keep = f.range * 0.82;
          if (d < keep * 0.75) { f.x -= dx / d * f.es * 0.8 * SIM_DT; f.y -= dy / d * f.es * 0.8 * SIM_DT; }
          else if (d > keep) { f.x += dx / d * f.es * SIM_DT; f.y += dy / d * f.es * SIM_DT; }
          if ((f.shotT -= SIM_DT) <= 0 && d < f.range) { f.shotT = f.shotCd; if (SHOOTERS.includes(f.beh)) fire(f, dx / d, dy / d, t); }
          continue;
        }
        if (f.beh === 'bomber' && d < f.r + pl.r + 26) {         // prende la mecha: estalla en 1 s, 62 px, daño ×1,4
          f.fuse = true; f.pt = 1.0;
          zones.push({ h: { kind: 'zone', x: f.x, y: f.y, r: 62 }, at: t + 1.0, hit: taken(pl, f.raw * 1.4, f.type, false, f.cat) });
          continue;
        }
        let v = f.es;
        if (f.boss) {
          if (f.bossMode === 'cast') continue;
          if (f.bossMode === 'far' && d < 300) {
            if (d < 170) { f.x -= dx / d * f.es * SIM_DT; f.y -= dy / d * f.es * SIM_DT; }
            continue;                                             // te rodea sin acercarse
          }
          v = f.es * 1.1 * f.fury;
        } else if (f.beh === 'charger') {                                  // apunta 0,55 s y embiste ×3,4 durante 0,42 s
          f.pt -= SIM_DT;
          if (f.phase === 'aim') { v = 0; if (f.pt <= 0) { f.phase = 'dash'; f.pt = 0.42; f.dx = dx / d; f.dy = dy / d; } }
          else if (f.phase === 'dash') { if (f.pt <= 0) { f.phase = 'walk'; f.pt = 1.1; } }
          else if (d < 200 && f.pt <= 0) { f.phase = 'aim'; f.pt = 0.55; v = 0; }
          if (f.phase === 'dash') {
            const mv = f.es * 3.4 * SIM_DT;
            f.x += f.dx * mv; f.y += f.dy * mv;
            if (Math.hypot(px - f.x, py - f.y) <= f.r + pl.r + 1) touching.push(f);
            continue;
          }
        }
        // No se paran al tocarte: van hasta tu centro (enemy.js update; sólo se separan entre ellos), así que
        // quien te alcanza sigue encima hasta que le sacas su radio + el tuyo (y te vuelve a pegar a los 0,55 s).
        const mv = Math.min(v * SIM_DT, d);
        if (mv > 0) { f.x += dx / d * mv; f.y += dy / d * mv; }
        if (Math.hypot(px - f.x, py - f.y) <= f.r + pl.r + 1) touching.push(f);
      }
      // Tu hueco tumba al más cercano a tiro.
      if (spec.dps > 0) {
        let tg = null, td = spec.range || 0;
        for (const f of foes) { if (f.dead) continue; const d = Math.hypot(f.x - px, f.y - py); if (d <= td) { td = d; tg = f; } }
        if (tg && (tg.hp -= spec.dps * SIM_DT) <= 0) tg.dead = true;
      }
      // Daño: avisos del suelo (saltan la invulnerabilidad), disparos y contactos.
      for (const z of zones) if (!z.done && z.at <= t + 1e-6) { z.done = true; if (G.Hazards.inside(z.h, px, py, pl.r)) hurt(z.hit, t, true); }
      for (const s of shots) {
        if (s.done || t < s.t0) continue;
        if (t > s.stop || t - s.t0 > 2.4) { s.done = true; continue; }
        const sx = s.x + s.vx * (t - s.t0), sy = s.y + s.vy * (t - s.t0);
        if ((sx - px) ** 2 + (sy - py) ** 2 < (s.r + pl.r) ** 2) { s.done = true; hurt(s.hit, t); }
      }
      touching.sort((a, b) => b.hit - a.hit);
      for (const f of touching) if (!f.dead && f.touch <= 0) { f.touch = TOUCH_CD; if (spec.onTouch) spec.onTouch(t, f.id, t >= inv); hurt(f.hit, t); }
      cum.push(dmg);
      if (t <= 2 + 1e-6) dmg2 = dmg;
    }
    return { dmg: Math.round(dmg), dmg2: Math.round(dmg2), ko, cum };
  }

  /** Camino que sigue cada táctica en la simulación (lo mismo que hace el piloto, en línea recta). */
  function simSpec(pl, F, c) {
    const s = F.slots[Number.isInteger(c.slot) ? c.slot : pl.active] || F.slots[pl.active];
    const spec = { dps: s ? s.dps : 0, range: s ? Math.min(520, s.range) : 0 };
    const keepFrom = (id, keep) => (x, y, by, th) => {
      const f = th && th.id === id ? th : by.get(id);
      if (!f || f.dead) return null;
      const [ux, uy] = U.norm(x - f.x, y - f.y);
      return [f.x + ux * keep, f.y + uy * keep];
    };
    switch (c.kind) {
      case 'fight': return { ...spec, within: 6, at: keepFrom(c.targetId, c.keep || 200), thief: c.thief || null };
      case 'evade': return { ...spec, at: (x, y) => [x + c.dir[0] * 100, y + c.dir[1] * 100] };
      case 'circle': {
        const [ax, ay] = c.anchor;
        return { ...spec, at: (x, y) => { const th = Math.atan2(y - ay, x - ax) + c.dir * 0.55; return [ax + Math.cos(th) * c.R, ay + Math.sin(th) * c.R]; } };
      }
      case 'collect': case 'goto': return { ...spec, within: Math.max(4, c.within != null ? c.within : 10), arriveSafe: c.id === 'rift', at: () => c.goal };
      case 'lure': {
        const [tx, ty] = c.trap, [ux, uy] = U.norm(tx - pl.x, ty - pl.y);
        const g = [tx + (ux * 0.94 - uy * 0.34) * 120, ty + (uy * 0.94 + ux * 0.34) * 120];
        return { ...spec, at: () => g };
      }
      default: return spec;
    }
  }

  // Cuántos hay cerca y cómo cambia (para ver llegar una marea: spawner.js update).
  const hist = [];          // [{ t, n150, n300 }] con el reloj de la partida
  function countsAgo(now, s) {
    let best = null;
    for (const h of hist) if (h.t >= now - s - 0.15) { best = h; break; }
    return best;
  }

  /**
   * Peligro del momento (una vez por facts): quedarse quieto 2-3 s, cuántos a 150/300 px y cuánto han
   * cambiado, marea y evento. surge: a 150 px hay 6 o más y 4+ más que hace 1 s, o a 300 px 10+ más que hace 2 s
   * (en las partidas de prueba del 16-10-2026 los dos golpes más grandes llegaron justo después de eso).
   */
  function dangerOf(pl, F) {
    if (F._danger) return F._danger;
    const now = G.Game.st ? G.Game.st.time : 0;
    let n150 = 0, n300 = 0;
    for (const x of F.enemies) { if (x.d <= 150) n150++; if (x.d <= 300) n300++; }
    const last = hist[hist.length - 1];
    if (!last || now - last.t >= 0.2 || now < last.t) {
      if (last && now < last.t) hist.length = 0;               // partida nueva
      hist.push({ t: now, n150, n300 });
      while (hist.length && hist[0].t < now - 4) hist.shift();
    }
    const a1 = countsAgo(now, 1), a2 = countsAgo(now, 2), a3 = countsAgo(now, 3);
    const d150_1 = a1 ? n150 - a1.n150 : 0, d300_2 = a2 ? n300 - a2.n300 : 0, d150_3 = a3 ? n150 - a3.n150 : 0;
    const surge = (n150 >= 6 && d150_1 >= 4) || d300_2 >= 10;
    const act = F.slots[pl.active];
    const stay = simulate(pl, F, { dps: act ? act.dps : 0, range: act ? Math.min(520, act.range) : 0 });
    const ev = G.Events.info;
    const event = ev ? (ev.id === 'horde' ? 'horde ' + ev.type : ev.id === 'gold' ? 'golden hour' : 'lost pokemon') : '';
    const boss = F.enemies.some(x => x.e.boss);
    const sg = d150_3 >= 0 ? '+' : '';
    const text = `HP ${Math.round(pl.hp)}/${Math.round(pl.maxHp)}; stay put 2s: -${stay.dmg2}${stay.dmg2 >= pl.hp ? ' (KO)' : ''}; ` +
      `${n150} within 150px (${sg}${d150_3} in 3s)${surge ? '; SURGE' : ''}${event ? '; ' + event : ''}${boss ? '; boss' : ''}`;
    return (F._danger = { stay, n150, n300, d150_1, d150_3, d300_2, surge, event, text: text.length > 80 ? text.slice(0, 79) + '…' : text, t: now });
  }

  /** Daño previsto de una táctica y los tres números de peligro que se le añaden. */
  function addDanger(pl, F, c) {
    const D = dangerOf(pl, F);
    const r = c._sim || simulate(pl, F, simSpec(pl, F, c));
    c.danger = r; delete c._sim;
    const keys = Object.keys(c.numbers || {});
    const base = {};
    for (const k of keys.slice(0, 13)) base[k] = c.numbers[k];     // 13 + 3 = 16 (mcp/src/jev-http.js LIMITS)
    c.numbers = { ...base, est_damage_next_3s: r.dmg, survives_next_3s: r.ko == null, danger_now: D.text };
    return r;
  }

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

  /** Salir del cerco por el mejor hueco (también lo usa el reflejo de autopilot.js aunque no esté entre las candidatas). */
  function escapeCandidate(pl, F, danger = 0) {
    const hp = F.hpFrac, near200 = F.enemies.filter(x => x.d < 200 && !x.th.keeper).length;
    const gap = F.gap || { dir: [1, 0], clear: 0 };
    return {
      id: 'evade', kind: 'evade', dir: gap.dir,
      label: `Break out to the ${dirName(gap.dir)} gap and regroup`,
      score: 0.2 + 0.08 * F.occupied / 2 + (hp < 0.35 ? 0.35 : 0) + Math.min(0.3, danger * 0.25),
      numbers: { surrounded_sectors_of_16: F.occupied, enemies_within_200px: near200, gap_direction: dirName(gap.dir), gap_clearance_px: Math.round(gap.clear), hp_percent: Math.round(hp * 100) }
    };
  }

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
      // La pelea es contra el grupo de alrededor, no contra uno: cuánto se tarda en limpiarlo y cuánto
      // daño te harán mientras (simulación de 3 s; más allá, al mismo ritmo).
      const group = F.enemies.filter(x => x.d <= 250);
      const groupHp = group.reduce((a, x) => a + x.e.hp, 0);
      const clearS = groupHp / Math.max(1, s.dps);
      const c = {
        id: 'fight_s' + s.index, kind: 'fight', slot: s.index, keep: s.keep, targetId: tg.e.id,
        label: `Fight the group around you with slot ${s.index + 1} (${s.moves.map(m => m.name).join(' + ')}): keep ${Math.round(s.keep)} px from ${nameOf(tg.e)}`,
        score,
        numbers: {
          slot: s.index + 1, move: s.main.kind + ' ' + s.main.type + (cur ? ' (active)' : ''),
          dps_vs_nearby: Math.round(s.dps), type_multiplier: r1(s.typeK), keep_distance_px: Math.round(s.keep),
          target: nameOf(tg.e), target_seconds_to_kill: r1(tg.ttk), target_outruns_you: tg.th.fast,
          group_within_250px: group.length, group_seconds_to_clear: r1(clearS)
        }
      };
      const sim = c._sim = simulate(pl, F, simSpec(pl, F, c));
      const i = Math.min(sim.cum.length, Math.max(1, Math.round(clearS / SIM_DT))) - 1;
      // Más allá de 3 s, al mismo ritmo; con tope en 2× tu vida máxima (pasado eso sólo dice "te tumban").
      c.numbers.est_damage_while_clearing = Math.min(Math.round(pl.maxHp * 2), Math.round(clearS <= SIM_H ? (sim.cum[i] || 0) : sim.dmg * clearS / SIM_H));
      if (s.orbit && !cur) c.numbers.note = 'switching to it re-creates its orbs';
      else if (!cur && pl.slots[pl.active] && pl.slots[pl.active].some(m => m.kind === 'orbit')) c.numbers.note = 'switching clears the orbs of the current slot';
      out.push(c);
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
    if (F.gap && (F.occupied >= 4 || near200 >= 3 || hp < 0.5)) out.push(escapeCandidate(pl, F, danger));

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
    specialTactics(pl, F, out, { ranked });
    // Peligro de cada una (lo mismo para todas: simulación de 3 s siguiendo su camino).
    for (const c of out) addDanger(pl, F, c);
    // Sin Jev (respaldo): si alguna te deja vivo, las que te dejan KO no van primero.
    const anySafe = out.some(c => c.danger.ko == null);
    if (anySafe) for (const c of out) if (c.danger.ko != null) c.score -= 0.6;
    out.sort((a, b) => b.score - a.score);
    // Máximo 6, pero salir del cerco, curarse, la grieta y los objetivos raros (duende, shiny, perdido)
    // no se quedan fuera, ni la que menos daño te hace: sustituyen a la peor que no sea de las protegidas.
    const safest = out.reduce((a, c) => (!a || c.danger.dmg < a.danger.dmg ? c : a), null);
    const KEEP = ['evade', 'heal', 'rift', 'thief', 'shiny', 'lost'];
    const kept = c => KEEP.includes(c.id) || c === safest;
    const top = out.slice(0, 6);
    for (const c of out.slice(6)) {
      if (!kept(c)) continue;
      const i = top.map(x => !kept(x)).lastIndexOf(true);
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
          // Lo que te quita cada golpe del legendario (contacto 36 + t/20, rift.js:143-149), con su tipo
          // más probable contra los tuyos, tu defensa y el −25 % con cuerpo a cuerpo (player.js hurt).
          let tk = 0;
          for (const p of pool) tk += G.Types.mult(p.types[0], pl.mon.types) * G.Stats.taken(pl.mon, p.cat) * p.w / W;
          const legHit = Math.max(1, Math.round(taken(pl, 36 + t / 20, null) * tk));
          const others = per.slice(1).map(x => `slot ${x.s.index + 1}: ${Math.round(x.dps)} dps x${r1(x.k)}`).join('; ');
          out.push({
            id: 'rift', kind: 'goto', goal: [gx, gy], within: 18, commit: true, slot: best.s.index,
            label: `Enter the rift ${Math.round(d)} px away and fight a legendary in its arena (${Math.round(rf.ttl)} s left to enter)`,
            score: 0.55 + (ttk < 60 ? 0.5 : ttk < 100 ? 0.25 : -0.15) + (hp >= 0.6 ? 0.05 : hp < 0.35 ? -0.3 : -0.1) - (near200 >= 3 ? 0.2 : 0) - Math.min(0.2, travel / 60),
            numbers: clip({
              est_seconds_to_kill: Math.round(ttk), arena_time_limit_s: 120, rift_seconds_left: Math.round(rf.ttl), walk_seconds: r1(travel),
              slot: best.s.index + 1, dps_vs_legend: Math.round(best.dps),
              ...(fixed ? { slot_fixed: fixed } : {}),
              legend_hp: legHp, legend_hit_damage_to_you: legHit, legend_hits_to_ko_you: Math.ceil(pl.hp / legHit),
              legend_likely_types: likely,
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
          const pd = propDps(pl, s, aimFree, p);
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

  /**
   * Objetivos raros que hay que decidir si merecen la pena: el duende del tesoro, un shiny, los dorados
   * de la hora dorada y el Pokémon perdido. Sólo se proponen si se puede (llegar a tiempo, tumbarlo...).
   */
  function specialTactics(pl, F, out, { ranked }) {
    if (G.Rift.inArena || !ranked.length) return;
    const spd = Math.max(30, drySpd(pl));
    const bestSlot = e => ranked.map(s => ({ s, dps: slotDpsVs(pl, s, e) })).sort((a, b) => b.dps - a.dps)[0];
    const hitTo = e => Math.round(taken(pl, e.dmg, e.atkType, false, e.cat));

    // Duende del tesoro (events.js:104-125): 92 px/s, huye en zigzag (a todo correr si estás a <300 px,
    // si no al 35 %; el zigzag de ±0,7 rad deja ~88 % de avance, enemy.js:283-296) y se va a los 15 s
    // (enemy.js:920). No hace daño (combat.js:664). Botín: Meowth 20 monedas de 5; Gholdengo 6 de 5 y
    // un ticket ×10 (enemy.js:181-186). El apuntado va al enemigo más cercano (player.js:368-375).
    for (const e of G.EnemyMgr.all()) {
      if (e.dead || e.behavior !== 'thief' || !(e.life > 0)) continue;
      const d = Math.hypot(e.x - pl.x, e.y - pl.y);
      if (d > 1000) continue;
      const b = bestSlot(e);
      if (!b || b.dps <= 0) continue;
      const reach = Math.min(520, b.s.range) * 0.85;
      const flee = e.spd * (1 - (e.slow || 0)) * G.Weather.speedFor(e.types) * 0.88;
      // Tiempo hasta tenerlo a tiro: lejos (>300 px) apenas se mueve; cerca huye a todo correr.
      let catchS = 0, ok = true;
      if (d > reach) {
        const far = Math.max(0, d - Math.max(300, reach)), near = Math.max(0, Math.min(d, 300) - reach);
        if (far) catchS += far / Math.max(1, spd - flee * 0.35);
        if (near) { if (spd - flee <= 5) ok = false; else catchS += near / (spd - flee); }
      }
      const ttk = e.hp / b.dps;
      const closer = F.enemies.filter(x => x.d < d).length;
      // Con enemigos más cerca que él, el apuntado va a ellos y el piloto los rodea: no se cuenta con cogerlo.
      const can = ok && catchS + ttk <= e.life && closer <= 2;
      if (!can) continue;
      out.push({
        id: 'thief', kind: 'fight', chase: true, slot: b.s.index, keep: Math.max(60, Math.min(140, reach * 0.5)), targetId: e.id,      // cerca: que sea el más cercano (el apuntado)
        thief: { id: e.id, x: e.x, y: e.y, es: e.spd * G.Weather.speedFor(e.types) },
        label: `Chase the treasure ${e.name} ${Math.round(d)} px away before it escapes (${Math.round(e.life)} s left)`,
        score: 0.55 + (e.def.loot === 'ticket10' ? 0.25 : 0.1) - closer * 0.04,
        numbers: {
          loot: e.def.loot === 'ticket10' ? 'x10 gacha ticket + 30 coins' : '100 coins',
          seconds_until_escape: r1(e.life), thief_hp: Math.round(e.hp), slot: b.s.index + 1, dps_vs_thief: Math.round(b.dps),
          seconds_to_kill: r1(ttk), seconds_to_get_in_range: r1(catchS), can_catch_in_time: can,
          thief_flee_speed: Math.round(flee), your_speed: Math.round(spd), distance_px: Math.round(d),
          enemies_closer_than_thief: closer, thief_hurts_you: false
        }
      });
      break;
    }

    // Shiny (spawner.js:73-87, enemy.js:83-89): vida ×2, experiencia ×5; al caer es tuyo para la colección
    // (o +300 monedas si ya lo tenías, game.js:271-281); no se va nunca (enemy.js:927).
    // (F.enemies ya sólo trae los de < NEAR px: es el mismo radio que el resto de tácticas.)
    const sh = F.enemies.filter(x => x.e.shiny && !x.e.boss && x.d < NEAR).sort((a, b) => a.d - b.d)[0];
    if (sh) {
      const e = sh.e, b = bestSlot(e);
      if (b && b.dps > 0) {
        const isNew = !(G.DB.ownsShiny && G.DB.ownsShiny(e.dex));
        out.push({
          id: 'shiny', kind: 'fight', slot: b.s.index, keep: b.s.keep, targetId: e.id,
          label: `Hunt the shiny ${nameOf(e)} ${Math.round(sh.d)} px away with slot ${b.s.index + 1}`,
          score: 0.5 + (isNew ? 0.25 : 0.1) - (F.hpFrac < 0.35 ? 0.2 : 0),
          numbers: {
            reward: isNew ? 'shiny joins your collection (new) + XP x5' : '300 coins (already owned) + XP x5',
            shiny_hp: Math.round(e.hp), xp: Math.round(e.xp), slot: b.s.index + 1, dps_vs_shiny: Math.round(b.dps),
            seconds_to_kill: r1(e.hp / b.dps), its_hit_damage_to_you: hitTo(e), outruns_you: sh.th.fast,
            distance_px: Math.round(sh.d), leaves_if_ignored: false
          }
        });
      }
    }

    // Hora dorada (events.js:72-74, spawner.js:88, enemy.js:93-96, :179): 30 s; los dorados dan el doble de
    // experiencia y el 35 % suelta 3 monedas.
    const ev = G.Events.info;
    if (ev && ev.id === 'gold') {
      const gold = F.enemies.filter(x => x.e.golden && x.d < 420);
      if (gold.length) {
        const s = ranked[0], hpSum = gold.reduce((a, x) => a + x.e.hp, 0), xp = gold.reduce((a, x) => a + x.e.xp, 0);
        const tg = gold.slice().sort((a, b) => a.d - b.d)[0];
        out.push({
          id: 'golden', kind: 'fight', slot: s.index, keep: s.keep, targetId: tg.e.id,
          label: `Golden hour: kill the ${gold.length} golden enemies nearby with slot ${s.index + 1}`,
          score: 0.5 + Math.min(0.3, gold.length * 0.05),
          numbers: {
            golden_within_420px: gold.length, their_xp: Math.round(xp), xp_bonus: 'x2 already counted', coins: '35% chance of 3 coins each',
            event_seconds_left: Math.round(ev.left || 0), slot: s.index + 1, dps_vs_nearby: Math.round(s.dps),
            est_seconds_to_kill_all: r1(hpSum / Math.max(1, s.dps)), nearest_distance_px: Math.round(tg.d)
          }
        });
      }
    }

    // Pokémon perdido (events.js:130-230): tocarlo (a < tu radio + el suyo + 18 px), te sigue y hay que
    // llevarlo a < 56 px de la marca; los enemigos que lo tocan le quitan min(30, Σ 4 + 0,12·daño) cada
    // 0,5 s (100 de vida); se va si cae o a los 120 s. Premio: cura el 50 % de tu vida, 12 monedas de 5,
    // un ticket y 1 de cada 5 veces se une a tu colección (si ya lo tienes, +150 monedas, game.js:261-266).
    const L = G.Events.lost;
    if (L) {
      const waiting = L.state === 'wait';
      const goal = waiting ? [L.x, L.y] : [L.tx, L.ty];
      const d = Math.hypot(goal[0] - pl.x, goal[1] - pl.y);
      const escort = Math.hypot(L.tx - L.x, L.ty - L.y);
      const need = walkTime(pl, goal[0], goal[1]) + (waiting ? escort * 1.15 / spd : 0);
      if (need < L.left) {
        const foes = F.enemies.filter(x => !x.th.keeper && Math.hypot(x.e.x - L.x, x.e.y - L.y) < 150).length;
        out.push({
          id: 'lost', kind: 'goto', goal, within: waiting ? Math.max(8, pl.r + L.r + 18 - 6) : 6,          // te sigue a ~tu radio + el suyo + 14 px: tú, encima de la marca
          label: waiting ? `Find the lost ${L.name} ${Math.round(d)} px away and escort it to the marker` : `Escort ${L.name} to the marker ${Math.round(d)} px away`,
          score: 0.45 + (F.hpFrac < 0.6 ? 0.15 : 0) - foes * 0.05,
          numbers: {
            step: waiting ? 'reach the pet, then escort it' : 'escort to the marker', distance_px: Math.round(d),
            escort_distance_px: Math.round(waiting ? escort : d), est_seconds_needed: r1(need), seconds_left: Math.round(L.left),
            pet_hp: Math.round(L.hp), pet_max_hp: L.maxHp, enemies_within_150px_of_pet: foes,
            reward: 'heal 50% of your HP, 60 coins, 1 ticket, 20%: the pet joins you',
            fail: 'pet leaves if its HP hits 0 or time runs out; no other penalty'
          }
        });
      }
    }
  }

  // (El resumen de reglas que lee Jev está en el servidor: mcp/src/jev-core.js GAME_RULES.)

  return { facts, candidates, hitRange, engageDist, moveDps, dpsOn, refDps, threatOf, targetFor, drySpd, dangerOf, escapeCandidate, addDanger, simulate };
})();
