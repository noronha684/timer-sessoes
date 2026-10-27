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

    // 13) Aba Sono removida (27/out/26): some a UI, ficam os DADOS (Agenda continua desenhando o sono)
    t('sono: aba, painel e modais saíram', !document.querySelector('.tab[data-panel="sono"]') && !$$('#sono-panel') && !$$('#alarmModal') && !$$('#sleepModal'));
    t('sono: funções de UI/alarme não existem mais', typeof renderSono === 'undefined' && typeof checkAlarms === 'undefined' && typeof fireAlarm === 'undefined');
    const sl = {};
    for (let i = 1; i <= 3; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      sl[dateKey(d)] = { durationMin: 420, source: 'whoop', at: Date.now(), recovery: 70 };
    }
    localStorage.setItem('timerSleep', JSON.stringify(sl));
    agendaWeekOffset = 0;
    renderAgenda();
    t('sono: dados guardados ainda aparecem na Agenda', document.querySelectorAll('#agendaTrack .tl-block.sleep').length > 0 || document.querySelector('#agendaSummary').textContent.length > 0);
    localStorage.removeItem('timerSleep');

    // 13a) Aba Plano simplificada: plano semanal do dono mora no Semestre (seção 07)
    renderPlano();
    const wpb = $$('#weekPlanBlock');
    t('plano: bloco do plano semanal some da aba Plano (dono)', !wpb || (wpb.style.display === 'none' && wpb.innerHTML === ''));
    t('plano: tarefas antes do tracker de balanços', !!($$('#tasksCard').compareDocumentPosition($$('#earnTrackerCard')) & Node.DOCUMENT_POSITION_FOLLOWING));
    t('plano: horas-alvo antes de aguardando', !!($$('#planGrid').compareDocumentPosition($$('#waitingCard')) & Node.DOCUMENT_POSITION_FOLLOWING));
    h2Active = 'plano';
    renderH2Section();
    t('semestre: seção 07 Plano semanal renderiza a tabela', H2_SECTIONS.some((s) => s.id === 'plano') && !!document.querySelector('#h2Content table'));
    h2Active = 'okrs';
    const errs = []; const oe = window.onerror;
    window.onerror = (m) => { errs.push(String(m)); };
    const abas = [...document.querySelectorAll('.tab')];
    abas.forEach((tb) => tb.click());
    await sleep(60);
    abas[0].click();
    window.onerror = oe;
    t('abas: 6 abas (sem Sono) e clicar em todas não gera erro', abas.length === 6 && errs.length === 0);

    // 13b) XP e níveis: curva, rotina por gesto, bônus, dia leve e sequência com folga/graça
    {
      const keep = { h: localStorage.getItem('timerHistory'), d: localStorage.getItem('timerH2Plan'), w: localStorage.getItem('timerWeekPlan'), s: localStorage.getItem('timerSessions') };
      const reset = () => { _xpCache = { min: -1, live: -1, val: null }; };
      const dk = (off) => dateKey(new Date(Date.now() + off * 86400000));
      t('XP: curva de níveis', xpLevelOf(0).level === 1 && xpLevelOf(99).level === 1 && xpLevelOf(100).level === 2 && xpLevelOf(299).level === 2 && xpLevelOf(300).level === 3);
      localStorage.setItem('timerWeekPlan', '{}');
      localStorage.setItem('timerH2Plan', '{}');
      localStorage.setItem('timerHistory', JSON.stringify({ [dk(0)]: { Work: 100 * 60000 } }));
      reset(); renderToday();
      t('XP: foco 100min = 40 XP', computeXp().hoje.xpFoco === 40);
      t('XP: pílulas da rotina renderizam', document.querySelectorAll('#routineLine .rot-pill').length === XP_ROTINA.length + 1);
      $$('#routineLine [data-rot="mexer"]').click();
      t('XP: pílula grava só em gesto (rot_ no h2Plan)', JSON.parse(localStorage.getItem('timerH2Plan'))['rot_' + dk(0) + '_mexer'] === 1);
      t('XP: rotina soma', computeXp().hoje.xpRot === 15);
      for (const it of XP_ROTINA) if (!rotinaDone(loadH2(), dk(0), it.id)) $$('#routineLine [data-rot="' + it.id + '"]').click();
      const full = computeXp().hoje;
      t('XP: dia perfeito (rotina 75 + foco 40 + essencial 20 + perfeito 40)', full.perfeito && full.xp === 175);
      $$('#routineLine [data-rot="mexer"]').click();
      t('XP: pílula desmarca', computeXp().hoje.xpRot === 60);
      $$('#routineLine [data-rot="mexer"]').click();
      t('feedback: "+N XP" aparece ao marcar pílula', !!document.querySelector('#xpLine .xp-pop'));
      // sequência: com meta na grade, dia vazio é falha; 1 deslize por semana é perdoado
      localStorage.setItem('timerWeekPlan', JSON.stringify({ Work: [8, 8, 8, 8, 8, 8, 8] }));
      localStorage.setItem('timerH2Plan', '{}');
      localStorage.setItem('timerHistory', JSON.stringify({ [dk(-2)]: { Work: 200 * 60000 }, [dk(0)]: { Work: 200 * 60000 } }));
      reset();
      t('XP: deslize isolado é perdoado (hoje + anteontem = 2)', computeXp().streak === 2);
      // dia leve: meta pela metade e limiar de sequência menor
      localStorage.setItem('timerHistory', JSON.stringify({ [dk(0)]: { Work: 80 * 60000 } })); // 32 XP
      localStorage.setItem('timerH2Plan', JSON.stringify({ ['leve_' + dk(0)]: 1 }));
      reset();
      t('XP: dia leve mantém sequência com 32 XP', computeXp().hoje.ganho === true && computeXp().streak === 1);
      localStorage.setItem('timerH2Plan', '{}');
      reset();
      t('XP: sem dia leve, 32 XP não vale a sequência', computeXp().hoje.ganho === false);
      // missões do dia (com meta na grade): metade da meta rende 15, meta cheia ainda não
      localStorage.setItem('timerWeekPlan', JSON.stringify({ Work: [8, 8, 8, 8, 8, 8, 8] }));
      localStorage.setItem('timerH2Plan', '{}');
      localStorage.setItem('timerSessions', '{}');
      localStorage.setItem('timerHistory', JSON.stringify({ [dk(0)]: { Work: 250 * 60000 } }));
      reset();
      const mh = computeXp().hoje;
      t('missões: metade ok, meta não', mh.missoes.find((m) => m.id === 'metade').ok && !mh.missoes.find((m) => m.id === 'meta').ok);
      t('missões: XP = foco 100 + metade 15', mh.xp === 115);
      renderToday();
      t('missões: linha renderiza', document.querySelectorAll('#missionLine .ms').length === 4);
      // combo: 3 sessões coladas (gap < 20 min) → bônus 0 + 4 + 10; gap grande quebra a cadeia
      const fim = Date.now() - 60000;
      const S = (end, min) => ({ category: 'Work', durationMs: min * 60000, at: end });
      const c3 = [S(fim - 120 * 60000, 50), S(fim - 55 * 60000, 50), S(fim, 50)]; // gaps 10 min e 5 min
      localStorage.setItem('timerSessions', JSON.stringify({ [dk(0)]: c3 }));
      localStorage.setItem('timerHistory', JSON.stringify({ [dk(0)]: { Work: 150 * 60000 } }));
      reset();
      const cb = computeXp().hoje.combo;
      t('combo: cadeia de 3 sessões dá ×1,5 e bônus 14', cb.n === 3 && cb.mult === 1.5 && cb.bonus === 14);
      const c2 = [S(fim - 200 * 60000, 50), S(fim, 50)]; // gap de ~100 min quebra
      localStorage.setItem('timerSessions', JSON.stringify({ [dk(0)]: c2 }));
      reset();
      t('combo: gap grande quebra a cadeia', computeXp().hoje.combo.bonus === 0);
      t('missões: 3 sessões conta sessões', computeXp().hoje.missoes.find((m) => m.id === 'sessoes').cur === 2);
      // títulos
      t('títulos por nível', tituloDe(1) === 'Iniciante' && tituloDe(4) === 'Consistente' && tituloDe(99) === 'Lenda');
      // recompensas reais: define, libera ao atingir o nível, resgata
      localStorage.setItem('timerSessions', '{}');
      localStorage.setItem('timerHistory', JSON.stringify({ [dk(0)]: { Work: 5 * 60000 } }));
      localStorage.setItem('timerH2Plan', '{}');
      reset();
      addReward(2, 'jantar fora');
      renderToday();
      t('recompensa: próxima aparece no card', $$('#rewardLine').textContent.includes('jantar fora') && $$('#rewardLine').textContent.includes('nível 2'));
      localStorage.setItem('timerHistory', JSON.stringify({ [dk(0)]: { Work: 1000 * 60000 } })); // 400 XP → nível 3
      reset(); renderToday();
      t('recompensa: liberada ao atingir o nível', $$('#rewardLine').textContent.includes('liberada'));
      $$('#rewardLine [data-rw="claim"]').click();
      t('recompensa: resgatar marca como feita', rewardsOf(loadH2())[0].done === true);
      if (keep.s == null) localStorage.removeItem('timerSessions'); else localStorage.setItem('timerSessions', keep.s);
      if (keep.h == null) localStorage.removeItem('timerHistory'); else localStorage.setItem('timerHistory', keep.h);
      if (keep.d == null) localStorage.removeItem('timerH2Plan'); else localStorage.setItem('timerH2Plan', keep.d);
      if (keep.w == null) localStorage.removeItem('timerWeekPlan'); else localStorage.setItem('timerWeekPlan', keep.w);
      reset(); renderToday();
    }

    // 13b2) Barra de XP no topo da aba Timer (sempre à vista, atualiza com a sessão rodando)
    {
      renderToday();
      const top = $$('#xpTop');
      t('barra de XP no topo do Timer: visível com nível, XP e barra', !!top && top.style.display !== 'none' && top.textContent.includes('XP hoje') && !!$$('#xpTopFill'));
      t('barra do topo fica ANTES do card de foco', !!(top.compareDocumentPosition($$('#focusIdle')) & Node.DOCUMENT_POSITION_FOLLOWING));
      window._xpTopAt = 0;
      $$('#startBtn').click();
      await sleep(80);
      const antes = $$('#xpTopPts').textContent;
      popXp(12, 'teste');
      t('feedback "+N XP" também aparece na barra do topo', !!document.querySelector('#xpTop .xp-pop'));
      $$('#stopBtn').click();
      await sleep(50);
      t('barra do topo continua depois de parar a sessão', $$('#xpTop').style.display !== 'none' && antes.length > 0);
    }

    // 13c) Agenda-modelo da semana → eventos recorrentes do Calendário (só por gesto)
    {
      const keepE = localStorage.getItem('timerEvents');
      localStorage.setItem('timerEvents', '{}');
      const total = () => Object.values(loadEvents()).reduce((a, l) => a + l.length, 0);
      const proxDia = (dow) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7)); return dateKey(d); };
      t('agenda-modelo: nada é gravado antes do gesto', !agendaSemanaCarregada() && total() === 0);
      const r1 = aplicarAgendaSemana();
      t('agenda-modelo: carrega todos os blocos', r1.n >= 45 && total() === r1.n);
      aplicarAgendaSemana();
      t('agenda-modelo: recarregar não duplica', total() === r1.n);
      const ter = eventsForDay(proxDia(2)).map((e) => e.text).join('|');
      t('agenda-modelo: terça tem Orizon, almoço e jantar', ter.includes('Orizon · bloco 1') && ter.includes('Almoço') && ter.includes('Jantar'));
      const seg = eventsForDay(proxDia(1)).map((e) => e.text).join('|');
      t('agenda-modelo: segunda tem Spravato e Orizon leve', seg.includes('Spravato') && seg.includes('Orizon leve'));
      const spr = eventsForDay(proxDia(1)).find((e) => e.text.startsWith('Spravato'));
      t('agenda-modelo: Spravato às 07:00, saúde, semanal', spr && spr.time === '07:00' && spr.cat === 'saude' && spr.recur === 'weekly');
      renderCalendar();
      t('agenda-modelo: botão "remover" aparece com agenda carregada', $$('#calAgendaDel').style.display !== 'none');
      t('agenda-modelo: NÃO inunda o radar de prazos', !h2Deadlines().some((d) => d.src === 'agenda' && /^agsem-/.test(String(d.evid || ''))));
      const ev0 = loadEvents(); const kk = dateKey(new Date());
      (ev0[kk] = ev0[kk] || []).push({ id: 'manual-1', text: 'compromisso meu', done: false });
      saveEvents(ev0);
      removerAgendaSemana();
      t('agenda-modelo: remover limpa só os blocos do modelo', !agendaSemanaCarregada() && total() === 1);
      if (keepE == null) localStorage.removeItem('timerEvents'); else localStorage.setItem('timerEvents', keepE);
      renderCalendar();
    }

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
