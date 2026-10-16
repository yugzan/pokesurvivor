/* ============ agent/ui.js — "Conexión con IA" en Ajustes y aviso en la partida ============
 * Pestaña IA de Ajustes (settings-ui.js la llama con render(box)): activar o no,
 * código de emparejamiento, estado y la dirección MCP para copiar.
 * Con un agente emparejado, en la partida sale "🤖 IA conectada" (no tapa nada:
 * el jugador puede seguir eligiendo sus cartas).
 * Sección "Jev" (js/agent/jev.js): clave de Jev y "Jev juega solo", sin agente;
 * mientras juega, el aviso dice "🤖 Jev juega".
 */
G.AgentUI = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const L = () => G.Agent.Link;
  const STATUS = {
    off: 'Desactivada', connecting: 'Conectando…', waiting: 'Esperando emparejamiento',
    paired: 'Conectada', unpaired: 'Desconectada', offline: 'Sin conexión con el servicio'
  };

  function render(box) {
    const i = L().info();
    let h = `<div id="agent-panel"><h3 class="set-h">Conexión con IA</h3>
      <p class="sub">Deja que un agente de IA (Claude, Codex…) juegue por ti a través de MCP. Tú puedes seguir eligiendo cartas cuando quieras.</p>
      <div class="set-row"><div class="grow"><b>Conexión con IA</b><small>Al activarla se pide un código para emparejar tu agente.</small></div>
        <button class="btn small ${i.on ? 'gold' : ''}" id="agent-on">${i.on ? 'Sí' : 'No'}</button></div>`;
    if (i.on) {
      h += `<div class="set-row"><div class="grow"><b>Estado</b></div>
          <span id="agent-st"><b class="${i.status === 'paired' ? 'gold' : ''}" style="display:inline">${esc(STATUS[i.status] || i.status)}</b>${i.status === 'paired' && i.client ? ` · <span translate="no">${esc(i.client)}</span>` : ''}</span></div>`;
      if (i.status !== 'paired' && i.code) {
        h += `<div class="set-row"><div class="grow"><b>Código de emparejamiento</b><small>Caduca a los 10 minutos si no se usa; luego sale otro.</small></div>
          <span class="agent-code gold" translate="no">${esc(i.code)}</span><button class="btn small" data-copy="${esc(i.code)}">Copiar</button></div>`;
      }
      h += `<div class="set-row"><div class="grow"><b>Dirección MCP</b><small>Añádela como servidor MCP en tu agente y pídele que llame a pair con el código.</small>
          <code class="agent-url" translate="no">${esc(i.mcp)}</code></div><button class="btn small" data-copy="${esc(i.mcp)}">Copiar</button></div>`;
    }
    h += jevRows();
    box.innerHTML = h + '</div>';
    $('agent-on').onclick = () => { if (L().on) L().disable(); else L().enable(); render(box); };
    box.querySelectorAll('[data-copy]').forEach(b => { b.onclick = () => copy(b.dataset.copy); });
    bindJev(box);
  }

  // ---------------- Jev en la página (js/agent/jev.js) ----------------
  function jevRows() {
    const J = G.AgentJev;
    if (!J) return '';
    const j = J.info();
    let h = `<h3 class="set-h" translate="no">Jev</h3>
      <p class="sub">Jev (TypeSafe) juega en esta página con tu propia clave: elige cartas, decide si cambiar opciones y mueve al personaje con el piloto automático. No hace falta ningún agente.</p>
      <div class="set-row"><div class="grow"><b>Clave de Jev</b><small>La clave sólo se guarda en este dispositivo. Se envía a TypeSafe a través del servidor de este sitio, que no la guarda.</small>
        <input class="field" type="password" id="jev-key" maxlength="1024" autocomplete="off" spellcheck="false" style="width:100%;margin-top:6px"
          placeholder="${j.hasKey ? 'Clave guardada' : 'Pega aquí tu clave'}"></div>
        <button class="btn small ${j.hasKey ? '' : 'hidden'}" id="jev-clear">Borrar</button></div>
      <div class="set-row"><div class="grow"><b>Jev juega solo</b><small>Elige siempre la carta más probable para Jev, cambia de movimiento y mueve al personaje. Las partidas que juega Jev salen en el ranking como jugadas por la IA (🤖).</small></div>
        <button class="btn small ${j.on ? 'gold' : ''}" id="jev-on">${j.on ? 'Sí' : 'No'}</button></div>`;
    // ¿Se quedó emparejado un agente (Claude, Grok...)? Manda Jev, pero se avisa y se puede desconectar.
    if (j.mcpPaired) {
      h += `<div class="set-row"><div class="grow"><b class="gold">${j.on ? 'Agente MCP emparejado, pero ahora juega Jev (automático)' : 'Hay un agente MCP emparejado'}</b>
        <small>${j.on ? 'Sus órdenes se siguen ejecutando. Si ya no lo usas, desconéctalo.' : 'Si enciendes Jev, jugará Jev; las órdenes del agente se seguirán ejecutando.'}</small></div>
        <button class="btn small" id="jev-unpair">Desconectar agente</button></div>`;
    }
    return h;
  }
  function bindJev(box) {
    const J = G.AgentJev;
    if (!J || !$('jev-on')) return;
    const keyIn = $('jev-key');
    // Sin volver a pintar el panel al guardar la clave: el clic en "Sí" que provoca este
    // 'change' (al perder el foco) se perdería si el botón se sustituye por otro.
    keyIn.onchange = () => {
      const v = keyIn.value.trim();
      if (!v) return;
      if (J.setKey(v)) {
        G.UI.toast('Clave de Jev guardada');
        keyIn.placeholder = 'Clave guardada';
        $('jev-clear').classList.remove('hidden');
      } else keyIn.value = '';
    };
    $('jev-clear').onclick = () => { J.setKey(''); render(box); };
    if ($('jev-unpair')) $('jev-unpair').onclick = () => { L().disable(); render(box); };
    $('jev-on').onclick = () => {
      const v = keyIn.value.trim();
      if (v && !J.setKey(v)) { keyIn.value = ''; return; }
      if (J.on) J.disable(); else J.enable();
      render(box);
    };
  }
  // Se vuelve a pintar sólo si Jev se enciende o se apaga (p. ej. clave rechazada), no al guardar la clave.
  let jevOnShown = G.AgentJev ? G.AgentJev.on : false;
  if (G.AgentJev) G.AgentJev.onChange(i => {
    tickBadge();
    if (i.on === jevOnShown) return;
    jevOnShown = i.on;
    const p = $('agent-panel');
    if (p && p.parentNode && document.activeElement !== $('jev-key')) render(p.parentNode);
  });

  function copy(text) {
    const done = () => G.UI.toast('Copiado');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
    else fallback(text, done);
  }
  function fallback(text, done) {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nada */ }
    t.remove();
  }

  // ---------------- aviso en la partida ----------------
  let badge = null, badgeText = '', last = 'off';
  function badgeEl() {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'agent-badge';
      badge.className = 'hidden';
      document.body.appendChild(badge);
    }
    return badge;
  }
  function tickBadge() {
    const inGame = G.Game && G.Game.state && G.Game.state !== 'ui';
    const jev = inGame && G.AgentJev && G.AgentJev.info().active;
    const show = jev || (L().status === 'paired' && inGame);
    if (!show && !badge) return;
    const el = badgeEl(), text = jev ? '🤖 Jev juega' : '🤖 IA conectada';
    if (text !== badgeText) { badgeText = text; el.textContent = text; }
    el.classList.toggle('hidden', !show);
  }
  setInterval(tickBadge, 500);

  G.Agent.on('status', i => {
    if (i.status === 'paired' && last !== 'paired') G.UI.toast(i.client ? 'IA conectada: ' + i.client : 'IA conectada');
    else if (last === 'paired' && i.status !== 'paired' && i.on) G.UI.toast('IA desconectada');
    last = i.status;
    tickBadge();
    const p = $('agent-panel');
    if (p && p.parentNode) render(p.parentNode);
  });

  // ---------------- traducciones ----------------
  G.I18n.add({
    'IA': 'AI', 'Conexión con IA': 'AI connection',
    'Deja que un agente de IA (Claude, Codex…) juegue por ti a través de MCP. Tú puedes seguir eligiendo cartas cuando quieras.':
      'Let an AI agent (Claude, Codex…) play for you through MCP. You can still pick cards yourself whenever you want.',
    'Al activarla se pide un código para emparejar tu agente.': 'Turning it on gets a code to pair your agent.',
    'Estado': 'Status', 'Desactivada': 'Off', 'Conectando…': 'Connecting…', 'Esperando emparejamiento': 'Waiting for pairing',
    'Conectada': 'Connected', 'Desconectada': 'Disconnected', 'Sin conexión con el servicio': 'Cannot reach the service',
    'Código de emparejamiento': 'Pairing code', 'Caduca a los 10 minutos si no se usa; luego sale otro.': 'Expires after 10 minutes if unused; then a new one appears.',
    'Dirección MCP': 'MCP address', 'Añádela como servidor MCP en tu agente y pídele que llame a pair con el código.': 'Add it as an MCP server in your agent and ask it to call pair with the code.',
    'Copiar': 'Copy', 'Copiado': 'Copied',
    '🤖 IA conectada': '🤖 AI connected', 'IA conectada': 'AI connected', 'IA conectada: {x}': 'AI connected: {x}', 'IA desconectada': 'AI disconnected',
    'Ocultar IA': 'Hide AI', 'Ocultar las marcas con IA (🤖 🧠)': 'Hide AI runs (🤖 🧠)',
    'Con ayuda de IA': 'AI-assisted', 'Ha jugado la IA': 'Played by AI', 'Tu marca con IA:': 'Your AI run:',
    'Jev (TypeSafe) juega en esta página con tu propia clave: elige cartas, decide si cambiar opciones y mueve al personaje con el piloto automático. No hace falta ningún agente.':
      'Jev (TypeSafe) plays on this page with your own key: it picks cards, decides when to reroll and moves the character with the autopilot. No agent needed.',
    'Clave de Jev': 'Jev key',
    'La clave sólo se guarda en este dispositivo. Se envía a TypeSafe a través del servidor de este sitio, que no la guarda.':
      'The key is only saved on this device. It is sent to TypeSafe through this site\'s server, which does not keep it.',
    'Clave guardada': 'Key saved', 'Pega aquí tu clave': 'Paste your key here', 'Borrar': 'Clear',
    'Jev juega solo': 'Jev plays on its own',
    'Clave de Jev guardada': 'Jev key saved', 'Pon primero tu clave de Jev': 'Enter your Jev key first',
    'Jev ha rechazado la clave: se ha desactivado Jev': 'Jev rejected the key: Jev has been turned off',
    'Jev no responde; se sigue intentando': 'Jev is not answering; still trying', '🤖 Jev juega': '🤖 Jev is playing',
    'Esa clave no es válida': 'That key is not valid',
    'Elige siempre la carta más probable para Jev, cambia de movimiento y mueve al personaje. Las partidas que juega Jev salen en el ranking como jugadas por la IA (🤖).': 'Always picks the card Jev rates highest, switches moves and moves the character. Runs played by Jev show on the leaderboard as played by AI (🤖).',
    'Agente MCP emparejado, pero ahora juega Jev (automático)': 'MCP agent paired, but Jev is playing now (automatic)',
    'Hay un agente MCP emparejado': 'An MCP agent is paired',
    'Sus órdenes se siguen ejecutando. Si ya no lo usas, desconéctalo.': 'Its commands still run. If you no longer use it, disconnect it.',
    'Si enciendes Jev, jugará Jev; las órdenes del agente se seguirán ejecutando.': 'If you turn Jev on, Jev plays; the agent\'s commands will still run.',
    'Desconectar agente': 'Disconnect agent'
  }, 'en');
  G.I18n.add({
    'IA': 'AI', 'Conexión con IA': 'AI 連線',
    'Deja que un agente de IA (Claude, Codex…) juegue por ti a través de MCP. Tú puedes seguir eligiendo cartas cuando quieras.':
      '讓 AI 代理（Claude、Codex…）透過 MCP 幫你玩。你隨時都能自己選卡。',
    'Al activarla se pide un código para emparejar tu agente.': '開啟後會取得一組配對碼，用來配對你的代理。',
    'Estado': '狀態', 'Desactivada': '已關閉', 'Conectando…': '連線中…', 'Esperando emparejamiento': '等待配對',
    'Conectada': '已連線', 'Desconectada': '已斷線', 'Sin conexión con el servicio': '連不上服務',
    'Código de emparejamiento': '配對碼', 'Caduca a los 10 minutos si no se usa; luego sale otro.': '10 分鐘內未使用就會失效，之後會換一組新的。',
    'Dirección MCP': 'MCP 網址', 'Añádela como servidor MCP en tu agente y pídele que llame a pair con el código.': '在你的代理加入這個 MCP 伺服器，請它用配對碼呼叫 pair。',
    'Copiar': '複製', 'Copiado': '已複製',
    '🤖 IA conectada': '🤖 AI 已連線', 'IA conectada': 'AI 已連線', 'IA conectada: {x}': 'AI 已連線：{x}', 'IA desconectada': 'AI 已斷線',
    'Ocultar IA': '隱藏 AI', 'Ocultar las marcas con IA (🤖 🧠)': '隱藏 AI 紀錄（🤖 🧠）',
    'Con ayuda de IA': 'AI 輔助', 'Ha jugado la IA': 'AI 操作', 'Tu marca con IA:': '你的 AI 紀錄：',
    'Jev (TypeSafe) juega en esta página con tu propia clave: elige cartas, decide si cambiar opciones y mueve al personaje con el piloto automático. No hace falta ningún agente.':
      'Jev（TypeSafe）用你自己的金鑰直接在這個網頁上玩：選卡、決定要不要重抽，並用自動駕駛移動角色。不需要任何代理。',
    'Clave de Jev': 'Jev 金鑰',
    'La clave sólo se guarda en este dispositivo. Se envía a TypeSafe a través del servidor de este sitio, que no la guarda.':
      '金鑰只存在這台裝置上。它會經由本站伺服器轉送給 TypeSafe，伺服器不會保存。',
    'Clave guardada': '已儲存金鑰', 'Pega aquí tu clave': '在這裡貼上你的金鑰', 'Borrar': '清除',
    'Jev juega solo': 'Jev 自動遊玩',
    'Clave de Jev guardada': '已儲存 Jev 金鑰', 'Pon primero tu clave de Jev': '請先輸入你的 Jev 金鑰',
    'Jev ha rechazado la clave: se ha desactivado Jev': 'Jev 拒絕了這把金鑰：已關閉 Jev',
    'Jev no responde; se sigue intentando': 'Jev 沒有回應，會繼續重試', '🤖 Jev juega': '🤖 Jev 遊玩中',
    'Esa clave no es válida': '這把金鑰格式不正確',
    'Elige siempre la carta más probable para Jev, cambia de movimiento y mueve al personaje. Las partidas que juega Jev salen en el ranking como jugadas por la IA (🤖).': '一律選 Jev 機率最高的卡、切換招式並移動角色。Jev 玩的場次會在排行榜上標示為 AI 操作（🤖）。',
    'Agente MCP emparejado, pero ahora juega Jev (automático)': 'MCP 代理已配對，但目前由 Jev 自動遊玩',
    'Hay un agente MCP emparejado': '有一個已配對的 MCP 代理',
    'Sus órdenes se siguen ejecutando. Si ya no lo usas, desconéctalo.': '代理的指令仍會執行。如果已經不用了，請中斷連線。',
    'Si enciendes Jev, jugará Jev; las órdenes del agente se seguirán ejecutando.': '開啟 Jev 後由 Jev 遊玩；代理的指令仍會執行。',
    'Desconectar agente': '中斷代理連線'
  }, 'zh-Hant');

  return { render };
})();
