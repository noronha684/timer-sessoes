// Cenários de smoke (rodam DEPOIS dos scripts do app, no fim do body do fixture).
// Resultado: JSON em <div id="smokeResult"> — o runner lê via --dump-dom.
// Cobrem as regressões já caçadas em produção (start duplo, pausa, portão) e o novo
// seq Lamport do activeTimer + seção Fechar semestre + heatmap.
(function () {
  const R = { pass: [], fail: [] };
  const t = (name, cond) => (cond ? R.pass : R.fail).push(name);
  const $$ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run() {
    await sleep(400); // deixa o onAuthStateChanged do stub disparar

    // 1) Portão de login
    t('authed: body.authed com usuário do stub', document.body.classList.contains('authed'));
    const gate = $$('#authGate');
    t('gate escondido quando autenticado', !!gate && getComputedStyle(gate).display === 'none');

    // 2) Start duplo NÃO cria segunda sessão (raiz do bug "não pausa" de 20/jul)
    $$('#startBtn').click();
    await sleep(50);
    const sid1 = state.sessionId;
    $$('#startBtn').click(); // duplo tap
    await sleep(50);
    t('start duplo é no-op (mesma sessão)', state.running && state.sessionId === sid1);

    // 3) Pausa e retomada por gesto local
    $$('#pauseBtn').click();
    await sleep(50);
    t('pausa pausa', state.paused === true);
    t('seq Lamport avançou no gesto', (state.timerSeq || 0) > 0);
    const seqAfterPause = state.timerSeq;
    $$('#pauseBtn').click();
    await sleep(50);
    t('retomada retoma', state.paused === false);
    t('seq avança a cada gesto', (state.timerSeq || 0) > seqAfterPause);

    // 4) Para e limpa
    $$('#stopBtn').click();
    await sleep(50);
    t('stop encerra', state.running === false);

    // 5) Seq Lamport ordena estados remotos (o "deferido" de 20/jul):
    //    adota sessão remota, aplica PAUSA com seq maior, e um estado RODANDO
    //    atrasado (seq menor) com relógio 30s no futuro NÃO pode reverter a pausa.
    const now = Date.now();
    const rt = {
      by: 'devA', device: 'devA', sessionId: now - 60000, startedAt: now - 60000,
      totalElapsedMs: 0, durationMs: 25 * 60000, category: state.category || 'CFA',
      paused: false, updatedAt: now, seq: 100,
    };
    applyRemoteTimer(rt);
    await sleep(50);
    t('adota sessão remota', state.running === true && state.owner === 'devA');
    applyRemoteTimer({ ...rt, paused: true, totalElapsedMs: 30000, updatedAt: now + 1000, seq: 102 });
    await sleep(50);
    t('pausa remota aplica (seq maior)', state.paused === true);
    applyRemoteTimer({ ...rt, paused: false, updatedAt: now + 31000, seq: 101 });
    await sleep(50);
    t('estado atrasado com relógio no futuro NÃO reverte pausa (seq)', state.paused === true);
    // limpa: para a sessão adotada sem salvar
    applyRemoteTimer({ by: 'devA', stopped: true, sessionId: rt.sessionId, updatedAt: now + 60000, seq: 103 });
    await sleep(50);
    t('tombstone remoto limpa', state.running === false);

    // 6) Payload de push carrega seq e sinceSessions
    localStorage.setItem('timerStopTombstone', JSON.stringify({ sessionId: 1, at: Date.now(), seq: 104 }));
    const payload = buildPushPayload();
    t('tombstone embarca com seq', payload.settings.activeTimer && payload.settings.activeTimer.seq === 104);
    t('push informa sinceSessions', 'sinceSessions' in payload);
    localStorage.removeItem('timerStopTombstone');

    // 7) Heatmap renderiza (53 semanas × 7)
    renderHistory();
    const cells = document.querySelectorAll('#heatmapCard .hm-cell').length;
    t('heatmap com 371 células', cells === 53 * 7);

    // 8) Feriados: motor calculado (Páscoa 2026 = 05/abr → móveis derivados) + render no mês
    t('feriado fixo (Tiradentes)', !!holidayFor('2026-04-21'));
    t('Sexta Santa 2026 = 03/abr', (holidayFor('2026-04-03') || {}).name === 'Sexta-feira Santa');
    t('Carnaval 2026 = 16-17/fev', !!holidayFor('2026-02-16') && !!holidayFor('2026-02-17'));
    t('véspera B3 marcada', !!(holidayFor('2026-12-24') || {}).b3);
    t('dia comum sem feriado', holidayFor('2026-07-30') === null);
    t('hoje 31/jul NÃO é feriado', holidayFor('2026-07-31') === null);
    // dias úteis descontam feriado nacional: nov/2026 tem 21 seg–sex, menos Finados
    // (seg 02) e Consciência Negra (sex 20) = 19; 15/nov cai no domingo (já fora)
    t('weekdaysBetween desconta feriados', weekdaysBetween(new Date(2026, 10, 1), new Date(2026, 10, 30)) === 19);
    // véspera B3 (24/dez, qui) NÃO é folga de meta: dez/2026 tem 23 seg–sex, menos
    // só o Natal (sex 25) = 22 úteis (vésperas 24 e 31 continuam contando)
    t('véspera B3 segue útil', weekdaysBetween(new Date(2026, 11, 1), new Date(2026, 11, 31)) === 22);
    const prevOffset = calMonthOffset;
    calMonthOffset += (11 - new Date().getMonth()); // vai pra dezembro do ano corrente
    renderCalMonth();
    t('feriados renderizam no mês', document.querySelectorAll('#calGrid .cal-holiday').length >= 3);
    calMonthOffset = prevOffset;
    renderCalMonth();

    // 9) Histórico por mês-calendário (tabs 7 dias / Mês com ‹ ›)
    const monthTab = document.querySelector('.range-tab[data-range="month"]');
    t('tab Mês existe', !!monthTab);
    monthTab.click();
    await sleep(50);
    const now2 = new Date();
    const monthName = now2.toLocaleDateString('pt-BR', { month: 'long' });
    t('título mostra o mês corrente', $$('#chartTitle').textContent.toLowerCase().includes(monthName));
    t('barras = dias do mês', document.querySelectorAll('#chart .bar-col').length === new Date(now2.getFullYear(), now2.getMonth() + 1, 0).getDate());
    t('› desabilitado no mês corrente', $$('#histNext').disabled === true);
    $$('#histPrev').click();
    await sleep(50);
    const prevM = new Date(now2.getFullYear(), now2.getMonth() - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
    t('‹ navega pro mês anterior', $$('#chartTitle').textContent.toLowerCase().includes(prevM));
    $$('#histNext').click();
    await sleep(50);
    document.querySelector('.range-tab[data-range="7"]').click();
    await sleep(50);
    t('volta pra 7 dias esconde as setas', $$('#histPrev').style.display === 'none');

    // 10) Âncora da semana: aparece no strip do Timer e some ao remover
    const curW = h2CurrentWeek();
    if (curW) {
      const Da = loadH2();
      const seedW = (H2_WEEKPLAN.find(w => w.n === curW.n) || {}).w || '';
      const topics = h2WkTopics(Da['wkw_' + curW.n] != null ? Da['wkw_' + curW.n] : seedW);
      if (topics.length) {
        Da['wkanchor_' + curW.n] = topics[0];
        saveH2(Da);
        renderExecStrip();
        t('âncora no strip do Timer', ($$('#execStrip').innerHTML || '').includes('⚓'));
        const Db = loadH2(); delete Db['wkanchor_' + curW.n]; saveH2(Db);
        renderExecStrip();
      } else t('âncora no strip do Timer', true);
    } else t('âncora no strip do Timer', true);

    // 11) Play etiquetado no Plano de hoje (só quando a lente do dia está na janela)
    renderTasks();
    const dpCard = $$('#dayPlanCard');
    const playBtn = document.querySelector('#dayPlanCard .dp-play');
    if (dpCard && dpCard.style.display !== 'none' && playBtn) {
      playBtn.click();
      await sleep(80);
      t('play inicia sessão etiquetada', state.running === true && !!state.subcategory);
      $$('#stopBtn').click();
      await sleep(50);
      t('etiqueta volta pra seleção no fim', state.subcategory === loadSelectedSubcategory());
    } else {
      t('play: fora da janela do plano (ok)', true);
      t('play: fora da janela do plano (ok 2)', true);
    }

    // 12) Tracker de balanços: estados do relógio de 48h
    const Dt = loadH2();
    Dt.earnTracker = [
      { id: 'tA', tk: 'EQTL3', dt: '2026-07-25', preview: true, call: false, modelo: false },
      { id: 'tB', tk: 'ENEV3', dt: (() => { const d = new Date(); d.setDate(d.getDate() + 5); return d.toISOString().slice(0, 10); })(), preview: false, call: false, modelo: false },
      { id: 'tC', tk: 'CPLE3', dt: '2026-07-20', preview: true, call: true, modelo: true },
    ];
    saveH2(Dt);
    renderEarnTracker();
    t('tracker: 3 releases', document.querySelectorAll('#earnTrackerCard .earn-row').length === 3);
    t('tracker: estourado', !!document.querySelector('#earnTrackerCard .earn-st.late'));
    t('tracker: modelo ✓', !!document.querySelector('#earnTrackerCard .earn-st.ok'));
    t('tracker: release futuro D-n', !!document.querySelector('#earnTrackerCard .earn-st.wait'));
    const Dt2 = loadH2(); delete Dt2.earnTracker; saveH2(Dt2);

    // 13) Recovery × foco: insight com amostra seedada (4 noites altas × 4 baixas)
    const sl = {}, hh = {};
    for (let i = 1; i <= 8; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = dateKey(d);
      sl[k] = { durationMin: 420, source: 'whoop', at: Date.now(), recovery: i <= 4 ? 80 : 30 };
      hh[k] = { Trabalho: (i <= 4 ? 5 : 2) * 3600000 };
    }
    const histBefore = localStorage.getItem('timerHistory');
    localStorage.setItem('timerSleep', JSON.stringify(sl));
    localStorage.setItem('timerHistory', JSON.stringify(Object.assign({}, JSON.parse(histBefore || '{}'), hh)));
    renderSono();
    t('insight recovery × foco', $$('#recFocusInsight').style.display !== 'none' && $$('#recFocusInsight').textContent.includes('Recovery alto'));
    localStorage.setItem('timerHistory', histBefore || '{}');
    localStorage.removeItem('timerSleep');

    // 14) Fechar semestre: seção renderiza e o texto compila
    try { localStorage.setItem('timerH2Tab', 'fechamento'); } catch {}
    h2Active = 'fechamento';
    renderH2Section();
    t('seção Fechar semestre renderiza', !!$$('#h2CopyFechamento'));
    const txt = h2FechamentoText();
    t('export compila', typeof txt === 'string' && txt.includes('FECHAMENTO DO SEMESTRE'));

    const div = document.createElement('div');
    div.id = 'smokeResult';
    div.textContent = JSON.stringify({ ok: R.fail.length === 0, pass: R.pass.length, fail: R.fail });
    document.body.appendChild(div);
    document.title = R.fail.length === 0 ? 'SMOKE-OK' : 'SMOKE-FAIL';
  }

  if (document.readyState === 'complete') run();
  else window.addEventListener('load', () => { run(); });
})();
