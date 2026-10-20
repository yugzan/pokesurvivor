/* ============ bridge.js — la partida vista y manejada por un agente de IA ============
 * Un agente externo (MCP, ver mcp/) juega a través de este puente:
 *   - state():  el estado de la partida (jugador, enemigos y objetos cercanos...)
 *   - choice(): la elección abierta (cartas de nivel, objeto o vínculo), con `cid`
 *               que sube cada vez que aparece una elección nueva (o cambian las cartas)
 *   - exec(op, args): choose, reroll, move, autopilot, active (movimiento activo), tactic, overlay, release
 * Elegir pasa por el mismo camino que el clic del jugador (G.RunUI).
 * La conexión (sólo si el jugador activa "Conexión con IA" en Ajustes):
 *   POST /agent/session -> { sid, code }   EventSource /agent/stream?sid=   POST /agent/report
 * Sin activarla no se hace ninguna petición a /agent.
 * En la versión publicada G no está en window (tools/build.js): la API pública es window.PokeAgent.
 */
G.Agent = (() => {
  const $ = id => document.getElementById(id);
  const RU = G.RunUI;
  const r1 = v => Math.round(v * 10) / 10;
  const listeners = {};
  function listen(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  function unlisten(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); }
  function emit(ev, data) { for (const fn of listeners[ev] || []) { try { fn(data); } catch (e) { console.warn('[IA]', e); } } }
  const markAI = n => { if (G.Game && G.Game.markAI) G.Game.markAI(n); };

  // ---------------- elecciones (enganchadas a G.RunUI sin cambiarlo) ----------------
  let lv = null;        // { list } cartas de nivel en pantalla
  let item = null;      // { cur, next }
  let bond = null;      // { opt, first }
  let cid = 0, choice = null, sig = '', overlayState = null;

  const showLevelUp = RU.showLevelUp;
  RU.showLevelUp = function (level, list) { lv = { list }; const r = showLevelUp.apply(this, arguments); refresh(true); return r; };
  // "Cambiar opciones" vuelve a pedir cartas a G.LevelUp.offer con la pantalla abierta.
  const offer = G.LevelUp.offer;
  G.LevelUp.offer = function () {
    const r = offer.apply(this, arguments);
    if (lv && lvOpen()) { lv = { list: r }; refresh(true); }   // (las cartas se pintan justo después)
    return r;
  };
  const showItemChoice = RU.showItemChoice;
  RU.showItemChoice = function (cur, next) { item = { cur, next }; const r = showItemChoice.apply(this, arguments); refresh(true); return r; };
  const showBond = RU.showBond;
  RU.showBond = function (opt) { bond = { opt, first: null }; const r = showBond.apply(this, arguments); refresh(true); return r; };
  const pickBond = RU.pickBond;
  RU.pickBond = function (i) { noteBond(i); return pickBond.apply(this, arguments); };

  const lvOpen = () => G.UI.isOpen('scr-levelup') && !$('cards').classList.contains('done');
  const bondStep2 = () => !!bond && bond.opt.mode === 'pair' && !$('bond-back').classList.contains('hidden');
  function bondList() {
    if (!bondStep2()) { bond.first = null; return bond.opt.loose; }
    return bond.opt.loose.filter(m => m !== bond.first);
  }
  /** Vínculo en dos pasos: hay que saber cuál se eligió primero (clic, tecla o IA). */
  function noteBond(i) {
    if (bond && bond.opt.mode === 'pair' && !bondStep2() && bond.opt.loose[i]) bond.first = bond.opt.loose[i];
  }

  function current() {
    if (lv && lvOpen()) {
      return { kind: 'levelup', rerolls: rerollsLeft(), cards: lv.list.map((c, i) => ({ index: i, key: c.key, type: c.type, ...esNames(c), desc: withDps(c) })) };
    }
    if (bond && G.UI.isOpen('scr-bond')) {
      const { opt } = bond, step2 = bondStep2(), list = bondList();
      const names = ms => ms.map(m => m.name).join(' + ');
      return {
        kind: 'bond', mode: opt.mode, step: step2 ? 2 : 1, rerolls: 0,
        cards: list.map((m, i) => ({
          index: i, key: 'bond:' + m.id, type: 'bond', title: m.name, tag: 'Nv.' + m.lvl,
          desc: opt.mode === 'add' ? 'Se lanzará a la vez que ' + names(opt.group) + '.'
            : step2 ? 'Se lanzará a la vez que ' + bond.first.name + '. Queda un hueco libre.' : m.desc || ''
        }))
      };
    }
    if (item && G.UI.isOpen('scr-item')) {
      return {
        kind: 'item', rerolls: 0,
        cards: [[item.cur, 'keep', 'Quedarme con'], [item.next, 'swap', 'Cambiar a']].map(([id, type, verb], i) => {
          const it = G.Items.BY[id] || { name: id, desc: '' };
          return { index: i, key: 'item:' + id, type, title: verb + ' ' + it.name, desc: it.desc };
        })
      };
    }
    return null;
  }

  /**
   * Carta de movimiento (nuevo, mejora, evolución): se le añade el daño por segundo que calcula la IA
   * (G.Tactics.refDps: a un blanco y a 10 repartidos) antes → después. Sólo si cabe en 200 caracteres
   * (mcp/src/jev-http.js sanitizeChoice corta ahí).
   */
  function withDps(c) {
    const desc = c.desc || '', pl = G.Game.player;
    try {
      const [kind, id] = String(c.key || '').split(':');
      const cur = pl && pl.moves.find(m => m.id === id);
      let next = null;
      if (kind === 'new' && G.Moves.BY_ID[id]) next = G.Moves.instance(id, 1);
      else if (kind === 'up' && cur) { next = Object.assign({}, cur); G.Moves.levelUp(next); }
      else if (kind === 'evo' && cur) { next = Object.assign({}, cur); G.Moves.evolve(next); }
      if (!next || !next.dmg) return desc;
      const a = kind !== 'new' ? G.Tactics.refDps(pl, cur) : null, b = G.Tactics.refDps(pl, next);
      const f = (x, y) => (x != null ? Math.round(x) + '→' : '') + Math.round(y);
      const tail = ` [IA: daño/s a 1 enemigo ${f(a ? a.one : null, b.one)}, a 10 ${f(a ? a.group : null, b.group)}]`;
      return desc.length + tail.length <= 200 ? desc + tail : desc;
    } catch (e) { return desc; }
  }

  /**
   * Título y etiqueta de una carta con los nombres de los movimientos en español, como player.moves y las
   * preguntas a Jev: levelup.js los pasa por G.T(name, 'move') al idioma del jugador (19-10-2026).
   * Se rehacen desde la clave (new:/up:/evo:/stat:) con los mismos datos que usa levelup.js; si algo no
   * cuadra, se deja lo que trae la carta.
   */
  function esNames(c) {
    const out = { title: c.title, tag: c.tag }, pl = G.Game.player;
    try {
      const [kind, id] = String(c.key || '').split(':');
      const cur = pl && pl.moves.find(m => m.id === id);
      if (kind === 'new' && G.Moves.BY_ID[id]) out.title = G.Moves.BY_ID[id].name;
      else if (kind === 'up' && cur) out.title = cur.name;
      else if (kind === 'evo' && cur) {
        const ev = G.Moves.evoInfo(cur, pl.statsTaken) || (G.Moves.EVO[id] ? { name: G.Moves.EVO[id][0] } : null);
        if (ev) out.title = cur.name + ' → ' + ev.name;
      } else if (kind === 'stat' && pl && typeof c.tag === 'string' && c.tag.startsWith('Evoluciona ')) {
        // levelup.js: el último movimiento que espera esta mejora para evolucionar (waiting[needs]).
        let evoFor = null;
        for (const m of pl.moves) { const ev = G.Moves.evoInfo(m, pl.statsTaken); if (ev && !ev.ready && ev.needs === id) evoFor = m; }
        if (evoFor) out.tag = 'Evoluciona ' + evoFor.name;
      }
    } catch (e) { /* se queda como venía */ }
    return out;
  }

  function rerollsLeft() {
    const p = G.Game.player;
    return p ? Math.max(0, 1 + (p.rerollBonus || 0) - (p.rerolls || 0)) : 0;
  }

  /** Recalcula la elección; si es otra (o `fresh`), sube el cid. */
  function refresh(fresh = false) {
    const c = current();
    const s = c ? c.kind + '|' + (c.step || '') + '|' + c.cards.map(x => x.key).join(',') : '';
    if (!fresh && s === sig) { if (c && choice) choice.rerolls = c.rerolls; return; }
    if (!c && !choice) { sig = ''; return; }
    sig = s;
    choice = c ? { cid: ++cid, ...c } : null;
    clearOverlay();
    emit('choice', choice);
  }

  // Se cierran (o cambian) sin pasar por nosotros: clic del jugador, tecla, cooperativo...
  function watch() {
    const mo = new MutationObserver(() => refresh());
    for (const id of ['scr-levelup', 'scr-item', 'scr-bond', 'cards', 'bond-back']) {
      const el = $(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    const bc = $('bond-cards');
    if (bc) bc.addEventListener('click', e => {
      const card = e.target.closest && e.target.closest('.card');
      if (card) noteBond([...bc.children].indexOf(card));
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();

  // ---------------- marcas sobre las cartas (probabilidades de la IA) ----------------
  const BOX = { levelup: 'cards', item: 'item-cards', bond: 'bond-cards' };
  function clearOverlay() {
    overlayState = null;
    document.querySelectorAll('.agent-ov').forEach(el => el.remove());
    document.querySelectorAll('.card.agent-pick').forEach(el => el.classList.remove('agent-pick'));
  }
  function drawOverlay() {
    const o = overlayState;
    if (!o || !choice || o.cid !== choice.cid) return;
    const box = $(BOX[choice.kind]);
    if (!box) return;
    box.querySelectorAll('.card').forEach((el, i) => {
      el.querySelectorAll('.agent-ov').forEach(x => x.remove());
      el.classList.toggle('agent-pick', o.pick === i);
      const p = o.probs[i];
      if (p == null && o.pick !== i) return;
      const ov = document.createElement('div');
      ov.className = 'agent-ov';
      ov.setAttribute('translate', 'no');
      ov.innerHTML = (p != null ? `<i style="width:${(p * 100).toFixed(1)}%"></i><span>${Math.round(p * 100)}%</span>` : '')
        + (o.pick === i ? `<b>🤖 ${o.source === 'jev' ? 'Jev' : 'IA'}</b>` : '');
      el.appendChild(ov);
    });
  }

  // ---------------- estado ----------------
  function state() {
    const g = G.Game, s = g.state, pl = g.player;
    const ap = { mode: G.Autopilot.mode, weights: G.Autopilot.weights };
    const ai = g.aiLevel || 0;
    if (s === 'ui' || !pl) return { phase: 'menu', ai, autopilot: ap };
    const near = (list, n, f) => {
      const out = [];
      for (const o of list) { if (o.dead) continue; const dx = o.x - pl.x, dy = o.y - pl.y; out.push([dx * dx + dy * dy, dx, dy, o]); }
      out.sort((a, b) => a[0] - b[0]);
      return out.slice(0, n).map(([d2, dx, dy, o]) => f(Math.round(dx), Math.round(dy), Math.round(Math.sqrt(d2)), o));
    };
    return {
      phase: s, time: r1(g.st ? g.st.time : 0), ai,
      player: {
        x: Math.round(pl.x), y: Math.round(pl.y), hp: Math.round(pl.hp), maxHp: Math.round(pl.maxHp),
        level: pl.level, xp: Math.round(pl.xp), xpNext: Math.round(pl.xpNext), kills: pl.kills,
        // maxLv, y si aún puede evolucionar: en qué, qué carta de stat lo pide y si ya la cogió
        // (G.Moves.evoInfo sólo responde al nivel máximo; se le pregunta como si ya lo estuviera).
        moves: pl.moves.map(m => {
          const o = { id: m.id, name: m.name, lv: m.lvl, maxLv: m.def.maxLvl };
          if (m.evolved) o.evolved = true;
          const ev = G.Moves.evoInfo(Object.assign({}, m, { lvl: m.def.maxLvl }), pl.statsTaken);
          if (ev) o.evo = { into: ev.name, needs: ev.needName, ready: ev.ready };
          return o;
        }),
        // Huecos (teclas 1, 2...): sólo se lanza el del hueco activo; un vínculo junta varios en uno.
        active: pl.active,
        slots: pl.slots.map((g, i) => ({ index: i, active: i === pl.active, moves: g.map(slotMove) })),
        locked: pl.hasItem('choiceband'),   // Cinta Elección: no se puede cambiar
        item: pl.item || null,
        stats: {
          spd: r1(pl.spd), atk: r1(pl.atk), cdMul: r1(pl.cdMul * 100) / 100, crit: r1(pl.critChance * 100) / 100,
          reduction: r1(pl.reduction * 100) / 100, regen: r1(pl.regen), magnet: Math.round(pl.magnet), xpMul: r1(pl.xpMul * 100) / 100,
          bosses: pl.bosses, coins: pl.coins, bonds: pl.bonds, rerolls: rerollsLeft(), slots: pl.slots.length, maxMoves: pl.maxMoves, active: pl.active,
          ...slotDps(pl, 5)
        }
      },
      enemies: near(G.EnemyMgr.all(), 40, (dx, dy, dist, e) => ({ dx, dy, dist, hp: Math.round(e.hp), maxHp: Math.round(e.maxHp), boss: !!e.boss, flying: !!e.flying, name: e.name, types: e.types || [] })),
      pickups: near(G.Pickups.all(), 30, (dx, dy, dist, p) => ({ dx, dy, kind: p.kind })),
      autopilot: ap,
      tactics: tactics(pl),
      map: mapInfo(pl)
    };
  }

  // ---------------- mapa alrededor ----------------
  // Lo que el agente no ve en enemies/pickups: terreno, objetos del escenario,
  // avisos en el suelo, disparos enemigos, grieta y arena. dx/dy relativos al jugador.
  const GRID_R = 12;                     // casillas a cada lado (casilla = 32 px)
  const PROP_CH = { tree: 'T', rock: 'o', chest: 'o', bigchest: 'B', altar: 'A', spring: 'S', trap: 'x', grass: '"' };
  const TRAP = ['poison', 'sticky', 'explosive'];
  const r2 = v => Math.round(v * 100) / 100;

  function mapInfo(pl) {
    const W = G.World, TS = W.TS;
    const ptx = Math.floor(pl.x / TS), pty = Math.floor(pl.y / TS);
    const near = W.propsNear(pl.x, pl.y, 640);
    // Rejilla: una fila por casilla de norte a sur, '@' = tú.
    const at = new Map();
    for (const p of near) at.set(p.tx + ',' + p.ty, p);
    const grid = [];
    for (let ty = pty - GRID_R; ty <= pty + GRID_R; ty++) {
      let row = '';
      for (let tx = ptx - GRID_R; tx <= ptx + GRID_R; tx++) {
        if (tx === ptx && ty === pty) { row += '@'; continue; }
        const k = W.kindAt(tx * TS + TS / 2, ty * TS + TS / 2), p = at.get(tx + ',' + ty);
        row += k === 'wall' ? '#' : p ? PROP_CH[p.type] || '?' : k === 'liquid' ? '~' : '.';
      }
      grid.push(row);
    }
    // Objetos del escenario (sin la hierba), los más cercanos primero.
    const props = [];
    for (const p of near) {
      if (p.type === 'grass') continue;
      const dx = Math.round(p.x - pl.x), dy = Math.round(p.y - pl.y), dist = Math.round(Math.hypot(dx, dy));
      if (dist > 640) continue;
      const o = { type: p.type, dx, dy, dist, solid: p.solid, breakable: p.destructible };
      if (p.destructible) o.hp = Math.round(p.hp);
      if (p.type === 'trap') o.trap = TRAP[p.kind] || 'trap';
      if (p.type === 'spring') o.charge = r2(p.charge);
      if (p.type === 'altar') o.used = p.used;
      if (p.type === 'bigchest') o.open = r1(p.open);
      props.push(o);
    }
    props.sort((a, b) => a.dist - b.dist);
    // Avisos en el suelo que aún no han golpeado.
    const hazards = [];
    for (const h of (G.Hazards ? G.Hazards.all : [])) {
      if (h.hit) continue;
      const dx = Math.round(h.x - pl.x), dy = Math.round(h.y - pl.y);
      if (dx * dx + dy * dy > 700 * 700) continue;
      const o = { kind: h.kind, dx, dy, in: r1(Math.max(0, h.delay - h.t)), inside: G.Hazards.inside(h, pl.x, pl.y, pl.r) };
      if (h.kind === 'zone') o.r = Math.round(h.r);
      else { o.angle = r2(h.angle); o.len = Math.round(h.len); o.w = Math.round(h.w); }
      hazards.push(o);
    }
    hazards.sort((a, b) => a.in - b.in);
    // Disparos enemigos cerca.
    const shots = [];
    for (const s of G.Projectiles.all()) {
      if (s.friendly || s.dead) continue;
      const dx = s.x - pl.x, dy = s.y - pl.y, d2 = dx * dx + dy * dy;
      if (d2 < 500 * 500) shots.push([d2, { dx: Math.round(dx), dy: Math.round(dy), vx: Math.round(s.vx), vy: Math.round(s.vy), r: Math.round(s.r) }]);
    }
    shots.sort((a, b) => a[0] - b[0]);
    const eff = W.liquidEffect(pl.mon.types) || {};
    const out = {
      biome: W.biomeName(),
      liquid: { kind: W.liquidKind(), slow: r2(eff.slow || 1), hurts: !!eff.dmg, slide: !!eff.slide },
      tile: TS,
      grid,
      props: props.slice(0, 30),
      hazards,
      shots: shots.slice(0, 20).map(x => x[1])
    };
    const rift = G.Rift.rift;
    if (rift) out.rift = { dx: Math.round(rift.x - pl.x), dy: Math.round(rift.y - pl.y), ttl: Math.ceil(rift.ttl) };
    const ar = W.arena;
    if (ar) out.arena = { dx: Math.round((ar.tx + 0.5) * TS - pl.x), dy: Math.round((ar.ty + 0.5) * TS - pl.y), r: ar.r * TS, type: ar.type };
    if (G.Events.current) out.event = G.Events.current;
    return out;
  }

  /** Tácticas candidatas (js/agent/tactics.js): las del piloto si va encendido, si no se calculan. */
  function tactics(pl) {
    if (pl.dead || G.Game.state !== 'playing') return { plan: null, candidates: [] };
    let list = G.Autopilot.mode !== 'off' ? G.Autopilot.candidates : null;
    if (!list || !list.length) { try { list = G.Tactics.candidates(pl); } catch (e) { list = []; } }
    const plan = G.Autopilot.plan;
    return {
      plan: G.Autopilot.mode !== 'off' && plan ? plan.id : null,
      candidates: list.map(c => ({ id: c.id, kind: c.kind, label: c.label, score: r1(c.score), numbers: c.numbers }))
    };
  }

  /**
   * Daño por segundo de cada hueco al grupo de alrededor según la IA (G.Tactics.facts), como
   * stats.dps_slot1, dps_slot2... (como mucho `room`: mcp/src/jev-http.js deja 20 claves en stats).
   */
  function slotDps(pl, room) {
    const o = {};
    try {
      // Los del piloto si son de hace < 0,5 s (no se calculan dos veces).
      const ap = G.Autopilot, F = ap && ap.facts && ap.facts.pl === pl && performance.now() - ap.factsAt < 500 ? ap.facts : G.Tactics.facts(pl);
      for (const s of F.slots.slice(0, room)) o['dps_slot' + (s.index + 1)] = Math.round(s.dps);
    } catch (e) { /* sin datos */ }
    return o;
  }

  /** Un movimiento de un hueco: tipo, forma de atacar (projectile, beam, melee...), alcance y recarga. */
  function slotMove(m) {
    const o = { id: m.id, name: m.name, lv: m.lvl, type: m.type, kind: m.kind, cd: r1(m.cd * 100) / 100 };
    if (typeof m.range === 'number') o.range = Math.round(m.range);
    // Onda por el suelo: llega a count·34 px + radius (combat.js reach, QSTEP), no sólo a su radio.
    else if (m.kind === 'quake') o.range = Math.round((m.count || 1) * 34 + (m.radius || 0));
    if (typeof m.radius === 'number') o.radius = Math.round(m.radius);
    return o;
  }

  // Empieza / acaba la partida (se mira el estado del juego).
  let prevState = 'ui';
  setInterval(() => {
    const s = G.Game && G.Game.state;
    if (!s || s === prevState) return;
    const was = prevState; prevState = s;
    const pl = G.Game.player;
    if ((was === 'ui' || was === 'over') && s !== 'ui' && s !== 'over' && pl) {
      emit('runStart', { dex: pl.dex, name: pl.mon.name, coop: !!(G.Coop && G.Coop.active) });
    } else if (s === 'over' && pl) {
      G.Autopilot.release();
      emit('runEnd', { time: r1(G.Game.st ? G.Game.st.time : 0), level: pl.level, kills: pl.kills, bosses: pl.bosses, dead: !!pl.dead, ai: G.Game.aiLevel || 0 });
    }
  }, 100);

  // ---------------- órdenes ----------------
  const ok = (data = {}) => ({ ok: true, data });
  const fail = error => ({ ok: false, error });
  const int = v => typeof v === 'number' && Number.isInteger(v);
  const num = v => typeof v === 'number' && isFinite(v);

  function exec(op, a) {
    a = a || {};
    try {
      switch (op) {
        case 'choose': {
          if (!choice || a.cid !== choice.cid) return fail('stale choice');
          if (!int(a.index) || !choice.cards[a.index]) return fail('bad index');
          const c = choice, i = a.index;
          markAI(2);
          if (c.kind === 'levelup') RU.pick(i);
          else if (c.kind === 'bond') RU.pickBond(i);
          else document.querySelectorAll('#item-cards .card')[i].click();
          refresh();
          return ok({ cid: c.cid, index: i, key: c.cards[i].key });
        }
        case 'reroll': {
          if (!choice || a.cid !== choice.cid) return fail('stale choice');
          if (choice.kind !== 'levelup' || rerollsLeft() <= 0) return fail('no rerolls left');
          markAI(2);
          RU.reroll();                    // -> G.LevelUp.offer -> refresh(true): cid nuevo
          return ok({ cid: choice && choice.cid, rerolls: rerollsLeft() });
        }
        case 'move': {
          if (!num(a.dx) || !num(a.dy)) return fail('dx, dy must be numbers');
          const ms = Math.max(50, Math.min(3000, Math.round(num(a.ms) ? a.ms : 500)));
          markAI(2);
          G.Autopilot.move(a.dx, a.dy, ms);
          return ok({ ms });
        }
        case 'autopilot': {
          if (!G.Autopilot.MODES.includes(a.mode)) return fail('mode must be one of ' + G.Autopilot.MODES.join('|'));
          if (a.mode !== 'off') markAI(2);
          G.Autopilot.set(a.mode, a.weights);
          return ok({ mode: G.Autopilot.mode, weights: G.Autopilot.weights });
        }
        case 'active': {                  // cambia el movimiento activo (como las teclas 1, 2...)
          const pl = G.Game.player;
          if (!pl || G.Game.state === 'ui' || G.Game.state === 'over') return fail('not in a run');
          if (!int(a.slot) || !pl.slots[a.slot]) return fail('bad slot');
          if (a.slot === pl.active) return ok({ active: pl.active });
          if (pl.hasItem('choiceband') && pl.slots[pl.active]) return fail('choice band: the active move cannot be changed');
          markAI(2);
          pl.setActive(a.slot);
          G.Autopilot.holdSlot();          // el piloto no lo vuelve a cambiar enseguida
          return pl.active === a.slot ? ok({ active: pl.active }) : fail('could not change the active move');
        }
        case 'tactic': {                  // la IA elige una táctica (id de state.tactics.candidates)
          if (G.Game.state !== 'playing' || !G.Game.player) return fail('not playing');
          if (typeof a.id !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(a.id)) return fail('bad tactic id');
          const ms = Math.max(500, Math.min(15000, Math.round(num(a.ms) ? a.ms : 4000)));
          markAI(2);
          if (G.Autopilot.mode === 'off') G.Autopilot.set('kite');
          G.Autopilot.useTactic(a.id, ms, a.source === 'jev' ? 'jev' : 'agent');
          const known = G.Autopilot.candidates.some(c => c.id === a.id);
          return ok({ id: a.id, ms, known });
        }
        case 'overlay': {
          if (!choice || a.cid !== choice.cid) return fail('stale choice');
          const probs = {};
          for (const [k, v] of Object.entries(a.probabilities || {})) {
            if (/^\d+$/.test(k) && num(v) && choice.cards[+k]) probs[+k] = Math.max(0, Math.min(1, v));
          }
          markAI(1);
          overlayState = { cid: choice.cid, probs, pick: int(a.pick) ? a.pick : null, source: a.source || 'jev' };
          drawOverlay();
          return ok({ cid: choice.cid });
        }
        case 'mark':                      // advice from the agent (e.g. Jev) the player may follow
          markAI(1);
          return ok();
        case 'release':
          G.Autopilot.release();
          return ok();
        default:
          return fail('unknown op: ' + op);
      }
    } catch (e) {
      return fail(String(e && e.message || e));
    }
  }

  // ---------------- conexión con el servicio MCP ----------------
  const Link = (() => {
    const LS = 'ps.agent', SS = 'ps.agent.s';
    let on = false, sid = null, code = null, expiresAt = 0, client = null, status = 'off';
    let es = null, wait = 1000, retryT = 0, loopT = 0, busy = false, again = false, epoch = 0;
    let results = [], events = [], choiceVer = 0, sentVer = 0;

    const store = () => { try { sessionStorage.setItem(SS, JSON.stringify({ sid, code, expiresAt, client })); } catch (e) { /* nada */ } };
    function setStatus(s, c) {
      if (c !== undefined) client = c;
      if (s === status && c === undefined) return;
      status = s;
      emit('status', info());
    }
    function info() { return { on, status, code: status === 'paired' ? null : code, client, expiresAt, mcp: location.origin + '/mcp' }; }

    function enable() {
      if (on) return;
      on = true; epoch++;
      try { localStorage.setItem(LS, '1'); } catch (e) { /* nada */ }
      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(SS) || 'null'); } catch (e) { /* nada */ }
      if (saved && saved.sid) { ({ sid, code, expiresAt, client } = saved); setStatus('connecting'); openStream(); }
      else newSession();
      loop();
    }

    function disable() {
      on = false; epoch++;
      try { localStorage.removeItem(LS); sessionStorage.removeItem(SS); } catch (e) { /* nada */ }
      if (es) { es.close(); es = null; }
      clearTimeout(retryT); clearTimeout(loopT);
      sid = code = client = null; results = []; events = [];
      G.Autopilot.release();
      setStatus('off');
    }

    async function newSession() {
      const my = epoch;
      if (es) { es.close(); es = null; }
      sid = null; client = null;
      setStatus('connecting');
      try {
        const res = await fetch('/agent/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        if (my !== epoch) return;
        sid = j.sid; code = j.code; expiresAt = j.expiresAt || Date.now() + 600000;
        store();
        sentVer = -1;                     // sesión nueva: se manda la elección actual
        openStream();
      } catch (e) {
        if (my !== epoch) return;
        retry(newSession);
      }
    }

    /** Reintento con espera creciente (1 s ... 30 s), sin llenar la consola. */
    function retry(fn) {
      if (!on) return;
      setStatus('offline');
      clearTimeout(retryT);
      if (wait === 1000) console.warn('[IA] sin conexión con el servicio; se reintenta en segundo plano');
      retryT = setTimeout(fn, wait);
      wait = Math.min(30000, wait * 2);
    }

    function openStream() {
      if (!on || !sid) return;
      if (es) es.close();
      const my = epoch;
      const src = es = new EventSource('/agent/stream?sid=' + encodeURIComponent(sid));
      const data = e => { try { return JSON.parse(e.data || '{}'); } catch (x) { return {}; } };
      src.addEventListener('hello', e => {
        wait = 1000;
        const d = data(e);
        if (d.paired) setStatus('paired');
        else if (status === 'paired' || client || !code) newSession();   // ya se usó el código: uno nuevo
        else setStatus('waiting', null);
        flush();
      });
      src.addEventListener('paired', e => { const d = data(e); setStatus('paired', d.client || 'agent'); store(); flush(); });
      src.addEventListener('unpaired', () => {
        G.Autopilot.release();
        setStatus('unpaired', null);
        newSession();                     // el código anterior ya no sirve
      });
      src.addEventListener('cmd', e => {
        const d = data(e);
        const r = exec(d.op, d.args);
        results.push(r.ok ? { id: d.id, ok: true, data: r.data } : { id: d.id, ok: false, error: r.error });
        flush();
      });
      src.onerror = () => {
        if (src !== es || my !== epoch) return;
        src.close(); es = null;
        // ¿Sigue valiendo la sesión? Un report lo dice (404 = no).
        retry(() => send(true));
      };
    }

    function inRun() { const s = G.Game && G.Game.state; return s && s !== 'ui' && s !== 'over'; }

    function loop() {
      clearTimeout(loopT);
      if (!on) return;
      if (status === 'waiting' && code && Date.now() > expiresAt) newSession();   // código caducado
      else send();
      loopT = setTimeout(loop, status === 'paired' ? (inRun() ? 250 : 1000) : 5000);
    }

    function flush() { send(); }

    /** POST /agent/report con lo pendiente. probe: tras un error del stream (reabre si la sesión vale). */
    async function send(probe = false) {
      if (!on || !sid) return;
      if (busy) { again = true; return; }
      busy = true;
      const my = epoch;
      const body = { sid, state: state() };
      const ver = choiceVer;
      if (ver !== sentVer) body.choice = choice;
      const rs = results, evs = events;
      if (rs.length) body.results = rs;
      if (evs.length) body.events = evs;
      results = []; events = [];
      try {
        const res = await fetch('/agent/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
        if (my !== epoch) return;
        if (res.status === 404) { newSession(); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        sentVer = ver;
        if (probe || !es) { wait = 1000; openStream(); }
      } catch (e) {
        if (my !== epoch) return;
        results = rs.concat(results); events = evs.concat(events);   // se vuelve a intentar
        if (probe) retry(() => send(true));
      } finally {
        busy = false;
        if (again && my === epoch) { again = false; send(); }
      }
    }

    listen('choice', () => { choiceVer++; if (on && sid) send(); });
    listen('runStart', d => { if (on) { events.push({ type: 'runStart', data: d }); send(); } });
    listen('runEnd', d => { if (on) { events.push({ type: 'runEnd', data: d }); send(); } });

    try { if (localStorage.getItem(LS) === '1') setTimeout(enable, 0); } catch (e) { /* nada */ }

    return { enable, disable, info, get on() { return on; }, get status() { return status; } };
  })();

  const api = {
    getState: state,
    getChoice: () => choice,
    choose: (index, c = choice && choice.cid) => exec('choose', { index, cid: c }),
    reroll: (c = choice && choice.cid) => exec('reroll', { cid: c }),
    move: (dx, dy, ms) => exec('move', { dx, dy, ms }),
    setAutopilot: (mode, weights) => exec('autopilot', { mode, weights }),
    setActive: slot => exec('active', { slot }),
    useTactic: (id, ms) => exec('tactic', { id, ms }),
    overlay: (probabilities, pick, c = choice && choice.cid) => exec('overlay', { cid: c, probabilities, pick, source: 'jev' }),
    release: () => exec('release', {}),
    exec,
    on: listen, off: unlisten,
    connect: () => Link.enable(),
    disconnect: () => Link.disable(),
    get link() { return Link.info(); }
  };
  window.PokeAgent = api;
  return Object.assign({ Link }, api);
})();
