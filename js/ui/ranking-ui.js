/* ============ ranking-ui.js — pantalla del ranking ============
 * Pestañas Solo / Grupo, periodo (diario ... histórico), todos o sólo amigos,
 * filtro por Pokémon (sólo en el histórico) y tu puesto abajo aunque no salgas
 * en el top. Lo leído se guarda 30 min (ver ranking.js).
 * Las marcas con IA llevan 🤖 (la IA jugó) o 🧠 (la IA ayudó) y se pueden
 * ocultar ("Ocultar IA": sólo aquí, en este navegador).
 */
G.RankingUI = (() => {
  const $ = G.UI.$;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let mode = 's', period = 'w', scope = 'all', dex = null;
  let token = 0;
  const HIDE_AI = 'ps.rk.hideAi';
  let hideAi = false;
  try { hideAi = localStorage.getItem(HIDE_AI) === '1'; } catch (e) { /* nada */ }
  const AI_MARK = { 1: ['🧠', 'Con ayuda de IA'], 2: ['🤖', 'Ha jugado la IA'] };

  function init() {
    const dl = $('rk-dl');
    dl.innerHTML = G.DEX.map(p => `<option value="${esc(G.T(p.name))}">`).join('');
    $('rk-poke').onchange = () => {
      const v = $('rk-poke').value.trim().toLowerCase();
      const p = G.DEX.find(x => (x.name.toLowerCase() === v || G.T(x.name).toLowerCase() === v));
      if (!v) { setDex(null); return; }
      if (!p) { G.UI.toast('No hay ningún Pokémon con ese nombre'); return; }
      setDex(p.dex);
    };
    $('rk-clear').onclick = () => { $('rk-poke').value = ''; setDex(null); };
    $('rk-mod').onclick = () => G.ModUI.open();
  }

  /** El filtro por Pokémon sólo existe en el histórico: al elegir uno se pasa a esa pestaña. */
  function setDex(d) {
    dex = d;
    if (d && period !== 'a') period = 'a';
    $('rk-clear').classList.toggle('hidden', !d);
    tabs(); load();
  }

  function open() {
    if (!G.SocialUI.needOnline()) return;
    G.UI.show('scr-rank', true);
    if (!G.Social.started) G.Social.start();
    $('rk-mod').classList.toggle('hidden', !G.Ranking.isAdmin());
    tabs();
    load();
  }

  function tabs() {
    const mk = (box, items, cur, set, cls) => {
      box.innerHTML = '';
      for (const [k, label] of items) {
        const b = document.createElement('button');
        b.className = cls + (k === cur ? ' on' : '');
        b.innerHTML = label;
        b.onclick = () => { set(k); tabs(); load(); };
        box.appendChild(b);
      }
    };
    mk($('rk-mode'), [['s', `<b>${G.Icons.html('user', 16)} Solo</b>`], ['g', `<b>${G.Icons.html('friends', 16)} Grupo</b>`]],
       mode, k => { mode = k; }, 'gen-tab');
    mk($('rk-period'), G.Ranking.PERIODS, period, k => {
      period = k;
      if (k !== 'a' && dex) { dex = null; $('rk-poke').value = ''; $('rk-clear').classList.add('hidden'); }
    }, 'chip');
    mk($('rk-scope'), [['all', 'Todos'], ['friends', 'Sólo amigos']], scope, k => { scope = k; }, 'chip');
    const hb = document.createElement('button');
    hb.className = 'chip rk-hideai' + (hideAi ? ' on' : '');
    hb.textContent = 'Ocultar IA';
    hb.title = 'Ocultar las marcas con IA (🤖 🧠)';
    hb.onclick = () => {
      hideAi = !hideAi;
      try { localStorage.setItem(HIDE_AI, hideAi ? '1' : '0'); } catch (e) { /* nada */ }
      tabs(); load();
    };
    $('rk-scope').appendChild(hb);
  }

  const fmt = t => t >= 3600 ? Math.floor(t / 3600) + ':' + G.U.mmss(t % 3600).padStart(5, '0') : G.U.mmss(t);

  async function load() {
    const my = ++token;
    const list = $('rk-list');
    list.innerHTML = '<p class="sub">Cargando…</p>';
    $('rk-me').innerHTML = '';
    let rows = [], me = null, meAi = null;
    try {
      [rows, me, meAi] = await Promise.all([
        G.Ranking.top(mode, period, dex, scope === 'friends'),
        G.Social.me ? G.Ranking.myRank(mode, period, dex) : Promise.resolve(null),
        G.Social.me && !hideAi ? G.Ranking.myRank(mode, period, dex, true) : Promise.resolve(null)
      ]);
    } catch (e) {
      if (my !== token) return;
      list.innerHTML = '<p class="sub">No se pudo cargar el ranking (' + esc(e.code || e.message) + ').</p>';
      return;
    }
    if (my !== token) return;
    list.innerHTML = '';
    if (hideAi) {
      rows = rows.filter(r => !r.ai);
      // Tu puesto entre las marcas sin IA (si estás en la lista).
      if (me && me.row) { const i = rows.findIndex(r => r.id === me.row.id); if (i >= 0) me = Object.assign({}, me, { pos: i + 1 }); }
    }
    if (!rows.length) {
      list.innerHTML = '<p class="sub">Todavía no hay marcas aquí. ¡Sé el primero!</p>';
    }
    const uid = G.Social.uid;
    const b = G.Ranking.board(mode, period, dex), done = G.Ranking.reported();
    rows.forEach((r, i) => list.appendChild(rowEl(r, i + 1, r.uids.includes(uid), b, done)));

    // La frase se monta en cada idioma (traducirla por trozos sale rara).
    const lang = G.I18n.lang, en = lang === 'en', pos = '#' + (me && me.capped ? '1000+' : me && me.pos);
    if (lang !== 'es' && !en) {
      // Otros idiomas: frases enteras sin periodo ni Pokémon (ya se ven en los filtros).
      const rk = $('rk-me');
      rk.setAttribute('translate', 'no');
      rk.textContent = !G.Social.me ? G.T('Elige un apodo (en Amigos) para salir en el ranking.')
        : me && me.out ? G.T('Aún no estás en el top 50. Tu puesto está en Histórico.')
        : me ? G.I18n.f('Tu mejor puesto: {x}', pos) + ' · ' + fmt(me.t)
        : G.T('Aún no tienes marca.');
      return;
    }
    const pn = en ? { d: 'today', w: 'this week', m: 'this month', y: 'this year', a: 'of all time' }[period]
                  : { d: 'de hoy', w: 'de esta semana', m: 'de este mes', y: 'de este año', a: 'de siempre' }[period];
    const mon = dex ? G.DEX_BY[dex].name : '';
    if (G.I18n.lang === 'zh-Hant') {
      const periodName = { d: '今日', w: '本週', m: '本月', y: '本年', a: '歷史' }[period];
      const modeName = mode === 's' ? '單人' : '多人';
      const label = periodName + modeName + (dex ? '（' + G.T(mon) + '）' : '');
      $('rk-me').textContent = !G.Social.me ? '請在好友頁面設定暱稱，以顯示於排行榜。'
        : me && me.out ? '你尚未進入' + label + '前 50 名。確切排名請查看歷史排行。'
        : me ? label + '最佳排名：#' + me.pos + ' · ' + fmt(me.t)
        : '你尚無' + label + '紀錄。';
      aiLine(meAi);
      return;
    }
    const where = en ? (mode === 's' ? 'solo' : 'group') + (dex ? ' with ' + mon : '')
                     : (mode === 's' ? 'en solitario' : 'en grupo') + (dex ? ' con ' + mon : '');
    $('rk-me').removeAttribute('translate');
    $('rk-me').innerHTML = !G.Social.me ? 'Elige un apodo (en Amigos) para salir en el ranking.'
      : me && me.out ? (en ? `<span translate="no">You're not in the top 50 ${where} ${pn} yet. Your rank is in All-time.</span>`
                           : `Aún no estás en el top 50 ${pn} ${where}. Tu puesto está en Histórico.`)
      : me ? (en ? `<span translate="no">Your best ${where} rank ${pn}: <b class="gold">${pos}</b> · ${fmt(me.t)}</span>`
                 : `Tu mejor puesto ${pn} ${where}: <b class="gold">${pos}</b> · ${fmt(me.t)}`)
      : (en ? `<span translate="no">You don't have a ${where} record ${pn} yet.</span>` : `Aún no tienes marca ${pn} ${where}.`);
    aiLine(meAi);
  }

  /** Tu marca con IA (aparte de la tuya), si la tienes. */
  function aiLine(m) {
    if (!m || m.out || !m.pos) return;
    const [ic, label] = AI_MARK[m.row && m.row.ai] || AI_MARK[2];
    $('rk-me').insertAdjacentHTML('beforeend',
      `<br><span class="rk-ai-me" title="${esc(label)}">${ic} <span>Tu marca con IA:</span> <b class="gold">#${m.pos}</b> · ${fmt(m.t)}</span>`);
  }

  function rowEl(r, pos, mine, b, done) {
    const el = document.createElement('div');
    el.className = 'rk-row' + (mine ? ' mine' : '') + (pos <= 3 ? ' top' + pos : '');
    el.insertAdjacentHTML('beforeend', `<span class="pos">${pos <= 3 ? G.Icons.html('trophy', 20) : ''}${pos}</span>`);
    const mons = document.createElement('span');
    mons.className = 'mons';
    r.dex.forEach((d, i) => { if (G.DEX_BY[d]) mons.appendChild(G.UI.spriteCanvas(d, 44, 40, { scale: 1, shiny: !!r.shiny[i] })); });
    el.appendChild(mons);
    const am = AI_MARK[r.ai];
    el.insertAdjacentHTML('beforeend',
      `<span class="who"><b translate="no">${am ? `<span class="rk-ai" title="${esc(am[1])}">${am[0]}</span> ` : ''}${r.names.map((n, i) => `<a href="#" class="plink" data-u="${esc(r.uids[i] || '')}">${esc(n)}</a>`).join(' · ')}</b><small>${am ? esc(am[1]) + ' · ' : ''}Nv. ${r.lv || 1} · ${(r.kills || 0).toLocaleString(G.I18n.locale)} derrotados</small></span>
       <span class="time">${fmt(r.t)}</span>`);
    el.querySelectorAll('.plink').forEach(a => { a.onclick = e => { e.preventDefault(); G.ProfileUI.show(a.dataset.u); }; });
    // Reportar una marca sospechosa (no la tuya). Lo revisa el admin (mod-ui.js).
    if (!mine && G.Social.me) {
      const rep = document.createElement('button');
      const sent = done.has(b + '__' + r.id);
      rep.className = 'rk-rep' + (sent ? ' sent' : '');
      rep.title = sent ? 'Ya la has reportado' : 'Reportar marca sospechosa';
      rep.innerHTML = G.Icons.html('flag', 16);
      rep.onclick = async () => {
        if (rep.classList.contains('sent')) { G.UI.toast('Ya has reportado esta marca'); return; }
        if (!confirm('¿Reportar la marca de ' + r.names.join(', ') + ' como trampa?')) return;
        rep.classList.add('sent'); rep.title = 'Ya la has reportado';
        await G.Ranking.report(b, r);
        G.UI.toast('Gracias: la revisaremos');
      };
      el.appendChild(rep);
    } else el.appendChild(document.createElement('span'));
    return el;
  }

  return { init, open };
})();
