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

    // 8) Fechar semestre: seção renderiza e o texto compila
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
