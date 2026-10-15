/* ============ agent/ui.js — "Conexión con IA" en Ajustes y aviso en la partida ============
 * Pestaña IA de Ajustes (settings-ui.js la llama con render(box)): activar o no,
 * código de emparejamiento, estado y la dirección MCP para copiar.
 * Con un agente emparejado, en la partida sale "🤖 IA conectada" (no tapa nada:
 * el jugador puede seguir eligiendo sus cartas).
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
    box.innerHTML = h + '</div>';
    $('agent-on').onclick = () => { if (L().on) L().disable(); else L().enable(); render(box); };
    box.querySelectorAll('[data-copy]').forEach(b => { b.onclick = () => copy(b.dataset.copy); });
  }

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
  let badge = null, last = 'off';
  function badgeEl() {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'agent-badge';
      badge.className = 'hidden';
      badge.textContent = '🤖 IA conectada';
      document.body.appendChild(badge);
    }
    return badge;
  }
  function tickBadge() {
    const show = L().status === 'paired' && G.Game && G.Game.state && G.Game.state !== 'ui';
    if (show || badge) badgeEl().classList.toggle('hidden', !show);
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
    'Con ayuda de IA': 'AI-assisted', 'Ha jugado la IA': 'Played by AI', 'Tu marca con IA:': 'Your AI run:'
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
    'Con ayuda de IA': 'AI 輔助', 'Ha jugado la IA': 'AI 操作', 'Tu marca con IA:': '你的 AI 紀錄：'
  }, 'zh-Hant');

  return { render };
})();
