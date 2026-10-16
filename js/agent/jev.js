/* ============ agent/jev.js — "Jev juega solo": Jev (TypeSafe) juega en esta página ============
 * Sin agente ni emparejamiento: con la clave de Jev del jugador (Ajustes > IA) y el
 * interruptor encendido, la página pregunta a Jev y usa el puente (js/agent/bridge.js):
 *   - cartas nuevas (cid nuevo)  -> POST /agent/jev {kind:'choice'} -> probabilidades sobre
 *     las cartas; si Jev ve todas malas (>0.7) y quedan cambios, "Cambiar opciones" (una
 *     vez por pantalla); si no, elige SIEMPRE la más probable (juego automático del todo:
 *     la confianza sólo se enseña).
 *   - en combate, cada 1,5 s     -> POST /agent/jev {kind:'tactic'} con las tácticas que calcula la
 *     página con las reglas del juego (js/agent/tactics.js: hueco, distancia, blanco, hueco del cerco,
 *     gemas, trampa...); Jev elige una y el piloto automático (autopilot.js) la ejecuta 3 s (exec 'tactic').
 *     Mientras Jev no contesta, el piloto sigue con la mejor según las reglas.
 *     Si el peligro se dispara (G.Autopilot.dangerSpike: el reflejo salta, quedarse quieto pasa a costar
 *     la mitad de la vida o llega una marea), se pregunta en el acto, sin esperar los 1,5 s; nunca dos
 *     preguntas a la vez ni con menos de 0,5 s entre ellas (mcp/src/jev-http.js deja 4 por segundo).
 * TypeSafe no deja llamar desde el navegador (CORS): el servidor del juego (mcp/src/jev-http.js)
 * reenvía la petición. La clave sólo se guarda en este dispositivo (localStorage).
 * La partida cuenta como jugada por la IA (🤖), igual que con un agente.
 * Con Jev encendido manda Jev, aunque haya un agente MCP emparejado (sus órdenes se siguen
 * ejecutando; Ajustes avisa de que hay un agente emparejado, por si se olvidó desconectarlo).
 */
G.AgentJev = (() => {
  const A = G.Agent;
  const LS_KEY = 'ps.jev.key', LS_ON = 'ps.jev.on';
  const REROLL_AT = 0.7, EVERY = 1500, MIN_GAP = 500, TACTIC_MS = 3000, PICK_DELAY = 700, ERR_WAIT = 3000, TIMEOUT = 25000;
  const KEY_OK = /^[\x21-\x7e]{1,1024}$/;    // como el servidor: sólo ASCII visible
  const ls = {
    get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* nada */ } }
  };
  const listeners = [];
  const emit = () => { for (const fn of listeners) { try { fn(info()); } catch (e) { console.warn('[Jev]', e); } } };

  let key = ls.get(LS_KEY).trim();
  let on = !!key && ls.get(LS_ON) === '1';
  let busy = false, lastAsk = 0, lastSpike = 0, spikeAsks = 0, handledCid = 0, rerolledCid = 0, nextStrategy = 0, waitUntil = 0, netWarned = false, epoch = 0;

  /** ¿Hay además un agente MCP emparejado? (No para a Jev: sólo se avisa en Ajustes.) */
  const mcpPaired = () => { const l = A.Link.info(); return l.on && l.status === 'paired'; };
  const inRun = () => { const s = G.Game && G.Game.state; return !!s && s !== 'ui' && s !== 'over'; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function info() { return { on, hasKey: !!key, mcpPaired: mcpPaired(), active: on && inRun() }; }

  /** Guarda la clave (vacía = borrarla). Devuelve false si no parece una clave. */
  function setKey(k) {
    const v = String(k || '').trim();
    if (v && !KEY_OK.test(v)) { G.UI.toast('Esa clave no es válida'); return false; }
    key = v;
    ls.set(LS_KEY, key);
    if (!key && on) disable();
    emit();
    return true;
  }

  function enable() {
    if (on) return true;
    if (!key || !KEY_OK.test(key)) { G.UI.toast('Pon primero tu clave de Jev'); return false; }
    on = true; epoch++;
    handledCid = 0; rerolledCid = 0; nextStrategy = 0; waitUntil = 0; netWarned = false;
    ls.set(LS_ON, '1');
    emit();
    return true;
  }

  function disable() {
    if (!on) return;
    on = false; epoch++;
    ls.set(LS_ON, '');
    if (!mcpPaired()) A.exec('release');       // el piloto automático lo puso Jev (con agente, lo deja)
    emit();
  }

  async function ask(body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);   // que una petición colgada no deje a Jev parado
    let res, j = null;
    try {
      res = await fetch('/agent/jev', {
        method: 'POST', cache: 'no-store', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'X-Jev-Key': key },
        body: JSON.stringify(body)
      });
      try { j = await res.json(); } catch (e) { /* nada */ }
    } finally { clearTimeout(t); }
    if (!res.ok) { const e = new Error((j && j.error) || 'HTTP ' + res.status); e.status = res.status; e.kind = j && j.kind; throw e; }
    netWarned = false;
    return j;
  }

  function onError(e) {
    waitUntil = Date.now() + ERR_WAIT;
    if (e && e.status === 401) {
      disable();
      G.UI.toast(e.kind === 'missing_key' ? 'Pon primero tu clave de Jev' : 'Jev ha rechazado la clave: se ha desactivado Jev', 4500);
      return;
    }
    if (e && e.status === 429) return;          // demasiadas peticiones: se espera un poco
    if (!netWarned) { netWarned = true; G.UI.toast('Jev no responde; se sigue intentando', 3500); }
    console.warn('[Jev]', e && e.message || e);
  }

  async function handleChoice(c) {
    const my = epoch;
    // Una sola vez por pantalla: las cartas que salen de "Cambiar opciones" no se vuelven a cambiar.
    const withReroll = c.kind === 'levelup' && c.rerolls > 0 && c.cid !== rerolledCid;
    const ev = await ask({ kind: 'choice', state: A.getState(), choice: c, withReroll });
    const still = () => on && my === epoch && A.getChoice() && A.getChoice().cid === c.cid;
    if (!still()) return;
    A.exec('overlay', { cid: c.cid, probabilities: ev.probabilities, pick: ev.choice, source: 'jev' });
    await sleep(PICK_DELAY);                    // que se vea lo que piensa Jev
    if (!still()) return;
    if (withReroll && (ev.reroll_probability || 0) > REROLL_AT) {
      const r = A.exec('reroll', { cid: c.cid });
      if (r.ok) {                               // las cartas nuevas llegan con otro cid
        rerolledCid = (r.data && r.data.cid) || (A.getChoice() && A.getChoice().cid) || 0;
        return;
      }
    }
    A.exec('choose', { index: ev.choice, cid: c.cid });   // la más probable, sin umbral de confianza
  }

  async function updateTactic() {
    const my = epoch;
    const st = A.getState();
    if (!st.tactics || st.tactics.candidates.length < 2) return;     // una sola opción: no hay nada que preguntar
    const s = await ask({ kind: 'tactic', state: st });
    if (!on || my !== epoch || G.Game.state !== 'playing' || !s || !s.tactic) return;
    const r = A.exec('tactic', { id: s.tactic, ms: TACTIC_MS, source: 'jev' });
    if (!r.ok) console.warn('[Jev] tactic:', r.error);
  }

  async function run(fn, onFail) {
    busy = true;
    try { await fn(); } catch (e) { if (onFail) onFail(); onError(e); } finally { busy = false; }
  }

  function tick() {
    if (!on || busy || !inRun() || Date.now() < waitUntil) return;
    const c = A.getChoice();
    if (c && c.cid !== handledCid) {
      handledCid = c.cid;
      // Si Jev falla (red, 5xx, 429...), se vuelve a preguntar por estas cartas al cabo de ERR_WAIT.
      run(() => handleChoice(c), () => { if (handledCid === c.cid) handledCid = 0; });
      return;
    }
    if (G.Game.state !== 'playing') return;
    // Cada partida empieza con el piloto apagado: "kite" (y la partida queda como jugada por la IA, 🤖).
    if (G.Autopilot.mode === 'off' || (G.Game.aiLevel || 0) < 2) {
      A.exec('autopilot', { mode: G.Autopilot.mode === 'off' ? 'kite' : G.Autopilot.mode });
      nextStrategy = Date.now() + EVERY;
    }
    if (Date.now() - lastAsk < MIN_GAP) return;
    const spike = G.Autopilot.dangerSpike;
    const urgent = spike !== lastSpike;
    lastSpike = spike;
    if (urgent || Date.now() >= nextStrategy) {
      if (urgent) spikeAsks++;
      lastAsk = Date.now(); nextStrategy = lastAsk + EVERY; run(updateTactic);
    }
  }
  setInterval(tick, 250);

  return {
    enable, disable, setKey, info,
    get on() { return on; }, get key() { return key; },
    /** Preguntas hechas en el acto porque el peligro se disparó. */
    get spikeAsks() { return spikeAsks; },
    onChange: fn => listeners.push(fn)
  };
})();
