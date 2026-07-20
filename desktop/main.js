// Timer de Sessões — casca desktop (Electron) sobre https://timer.gnoronha.app
// O site é a verdade (atualizações chegam sozinhas); aqui só entram os poderes de desktop:
// bandeja com o tempo restante, atalho global Ctrl+Alt+T, fechar→bandeja, modo mini
// always-on-top, modo flutuante nativo e "abrir com o Windows".
const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://timer.gnoronha.app';
const SMOKE = process.argv.includes('--smoke');
const smokeTrace = []; // rastro de diagnóstico impresso no fim do smoke

let win = null;
let tray = null;
let floatWin = null;
let floatAuto = false; // flutuante aberto AUTOMATICAMENTE ao minimizar (fecha sozinho ao restaurar)
let quitting = false;
let miniMode = false;
let savedBounds = null;
let lastState = null;

// Notificações nativas do Windows precisam do AppUserModelID casando com o instalador
app.setAppUserModelId('app.gnoronha.timer');

// Smoke roda com userData próprio: o nome vem do productName, então dev e app
// INSTALADO compartilham o mesmo lock de instância única — com o app aberto o
// smoke sairia mudo na hora (gotLock false) e pareceria um crash.
if (SMOKE) app.setPath('userData', path.join(require('os').tmpdir(), 'timer-sessoes-smoke'));

// Instância única: segunda abertura só traz a janela existente pra frente
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
}

function cleanUserAgent(ua) {
  // Google OAuth recusa "browsers embutidos": remove as assinaturas do Electron do UA
  // (o Electron injeta o productName sem espaços, ex.: "TimerdeSessões/1.0.1")
  return ua.replace(/\sElectron\/\S+/i, '').replace(/\sTimerdeSess\S+/i, '');
}

function fmtRemaining(ms) {
  // ceil, igual ao display do site — round divergia 1s metade do tempo
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// CUIDADO: numa BrowserWindow destruída o próprio getter `webContents` LANÇA
// ("Object has been destroyed") — checar win.isDestroyed() ANTES de tocar nele.
function mainAlive() {
  return !!(win && !win.isDestroyed() && !win.webContents.isDestroyed());
}

// Só hosts exatos (ou sufixo de domínio real) — regex solto era bypassável
// (ex.: accounts.google.com.attacker.com).
function isTrustedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    return h === 'accounts.google.com'
      || h === 'timer.gnoronha.app'
      || h === 'api.prod.whoop.com'
      || h === 'timer-sessoes.gabriel-noronha-o-p.workers.dev'
      || h.endsWith('.firebaseapp.com');
  } catch { return false; }
}

// ---- ponte com a página (sem tocar no site): lê o `state` global e clica nos botões ----
// Snippet comum: sem login não mexe; overlay "Sessão concluída" é dispensado antes
// de iniciar (senão a sessão nova começa ATRÁS do overlay, que só fecha no botão).
const JS_GUARDS =
  ' if (!document.body.classList.contains("authed")) return "sem-login";' +
  ' const o = document.getElementById("alertOverlay");' +
  ' if (o && o.classList.contains("active")) { const d = document.getElementById("dismissAlert"); if (d) d.click(); }';

async function readTimerState() {
  try {
    if (!mainAlive()) return null;
    return await win.webContents.executeJavaScript(
      '(() => { try { return { running: !!state.running, paused: !!state.paused, remainingMs: state.remainingMs|0, durationMs: state.durationMs|0, category: String(state.category||"") }; } catch (e) { return null; } })()',
      true
    );
  } catch { return null; }
}
function pageClick(sel) {
  if (!mainAlive()) return;
  win.webContents.executeJavaScript(
    '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); if (el) el.click(); })()',
    true
  ).catch(() => {});
}
// Pausar/retomar por INTENÇÃO (não toggle cego): rótulo velho de bandeja/float com
// o #pauseBtn alternante fazia "Pausar" RETOMAR quando o estado já tinha mudado.
function pagePauseIntent(wantPause) {
  if (!mainAlive()) return;
  win.webContents.executeJavaScript(
    '(() => { try { if (!state.running) return "parado";' +
    ' if (!!state.paused !== ' + (wantPause ? 'true' : 'false') + ') { const b = document.getElementById("pauseBtn"); if (b) b.click(); return "ok"; }' +
    ' return "ja-estava"; } catch (e) { return String(e); } })()',
    true
  ).catch(() => {});
}
// Iniciar SEMPRE guardado por state.running: o handler de start do site não tem
// guarda própria (agora tem no v144, mas cinto e suspensório) e um segundo click
// vazava um setInterval que entrava em loop de finishSession no fim da sessão.
function pageStartGuarded(presetMin) {
  if (!mainAlive()) return;
  win.webContents.executeJavaScript(
    '(() => { try {' + JS_GUARDS +
    ' if (state.running) return "ja-rodando";' +
    (presetMin
      ? ' const p = document.querySelector(".preset-pill[data-preset=\\"' + presetMin + '\\"]"); if (p) p.click();'
      : '') +
    ' const b = document.getElementById("startBtn"); if (b) b.click(); return "ok"; } catch (e) { return String(e); } })()',
    true
  ).catch(() => {});
}
function startPreset(min) {
  if (!mainAlive()) return;
  win.show();
  pageStartGuarded(min);
}
function toggleStartPause() {
  if (!mainAlive()) return;
  win.webContents.executeJavaScript(
    '(() => { try {' +
    ' if (state.running) { const b = document.getElementById("pauseBtn"); if (b) b.click(); return state.paused ? "retomou" : "pausou"; }' +
    JS_GUARDS +
    ' const s = document.getElementById("startBtn"); if (s) s.click(); return "iniciou";' +
    ' } catch (e) { return String(e); } })()',
    true
  ).catch(() => {});
}

// ---- modo flutuante NATIVO da casca ----
// O Document PiP do site NÃO funciona no Electron: o requestWindow resolve mas a
// janela morre no mesmo instante (pagehide imediato — sem controller de PiP no
// browser-side; verificado com sonda em 16/jul/26). O clique no botão do site é
// interceptado (captura + stopPropagation) e vira esta janelinha always-on-top.
function floatOpen() { return !!(floatWin && !floatWin.isDestroyed()); }
function setPipBtnLabel(open) {
  if (!mainAlive()) return;
  win.webContents.executeJavaScript(
    '(() => { const b = document.getElementById("pipBtn"); if (b) b.textContent = ' +
    JSON.stringify(open ? '✕ Fechar flutuante' : '◈ Modo flutuante') + '; })()',
    true
  ).catch(() => {});
}
function pushFloatState() {
  if (!floatOpen()) return;
  floatWin.webContents.send('float-state', lastState);
}
function createFloat() {
  floatWin = new BrowserWindow({
    // barra horizontal (anel + categoria/tempo/status + controles), janela
    // TRANSPARENTE pros cantos arredondados do cartão aparecerem de verdade
    width: 372, height: 92, useContentSize: true,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'float-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  floatWin.setAlwaysOnTop(true, 'floating');
  floatWin.loadFile('float.html');
  floatWin.webContents.once('did-finish-load', () => pushFloatState());
  // no quit as janelas morrem em ordem de criação (principal primeiro) — não
  // tocar em rótulo/bandeja de objetos possivelmente destruídos
  floatWin.on('closed', () => { floatWin = null; if (!quitting) { setPipBtnLabel(false); rebuildTray(); } });
  setPipBtnLabel(true);
  rebuildTray();
}
function toggleFloat() {
  floatAuto = false; // gesto manual: o flutuante passa a ser do usuário (não some ao restaurar)
  if (floatOpen()) floatWin.close();
  else createFloat();
}

// Auto-PiP: minimizou/escondeu o app com sessão rodando → flutuante aparece sozinho;
// restaurou → o que abriu sozinho fecha sozinho (o aberto manualmente fica).
function autoShowFloat() {
  if (SMOKE) smokeTrace.push('autoShow open=' + floatOpen() + ' running=' + !!(lastState && lastState.running) + ' quitting=' + quitting);
  if (quitting || floatOpen()) return;
  if (lastState && lastState.running) { floatAuto = true; createFloat(); }
}
function autoHideFloat() {
  if (SMOKE) smokeTrace.push('autoHide auto=' + floatAuto + ' open=' + floatOpen());
  if (floatAuto && floatOpen()) floatWin.close();
  floatAuto = false;
}

ipcMain.on('float-action', (_e, a) => {
  if (a === 'toggle') { toggleFloat(); return; }
  if (a === 'close') { if (floatOpen()) floatWin.close(); return; }
  if (a === 'pause') pagePauseIntent(true);
  else if (a === 'resume') pagePauseIntent(false);
  else if (a === 'start') pageStartGuarded();
  else if (a === 'stop') pageClick('#stopBtn');
  else return;
  // reflete a ação na janelinha/bandeja sem esperar o próximo poll
  setTimeout(async () => {
    lastState = await readTimerState();
    rebuildTray();
    pushFloatState();
  }, 250);
});

// ---- bandeja ----
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  return img.resize({ width: 16, height: 16 });
}
function rebuildTray() {
  if (!tray) return;
  const st = lastState;
  const status = !st ? 'Carregando…'
    : st.running
      ? (st.paused ? '⏸ ' : '● ') + fmtRemaining(st.remainingMs) + ' · ' + (st.category || '')
      : 'Nenhuma sessão rodando';
  const login = app.getLoginItemSettings().openAtLogin;
  const menu = Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    ...(st && st.running
      ? [
          // intenção capturada do rótulo EXIBIDO: menu velho não vira toggle às avessas
          { label: st.paused ? 'Retomar' : 'Pausar', click: () => pagePauseIntent(!st.paused) },
          { label: 'Parar sessão', click: () => pageClick('#stopBtn') },
        ]
      : [
          { label: 'Iniciar 25 min', click: () => startPreset(25) },
          { label: 'Iniciar 50 min', click: () => startPreset(50) },
          { label: 'Iniciar 60 min', click: () => startPreset(60) },
        ]),
    { type: 'separator' },
    { label: 'Mostrar / ocultar', click: () => (win.isVisible() ? win.hide() : (win.show(), win.focus())) },
    { label: 'Modo flutuante', type: 'checkbox', checked: floatOpen(), click: toggleFloat },
    { label: 'Modo mini (sempre visível)', type: 'checkbox', checked: miniMode, click: toggleMini },
    // ler o estado NA HORA do clique (closure do menu fica obsoleta) + rebuild,
    // senão com timer parado o toggle nunca conseguia DESLIGAR o autostart
    { label: 'Abrir com o Windows', type: 'checkbox', checked: login, click: () => {
      const cur = app.getLoginItemSettings().openAtLogin;
      app.setLoginItemSettings({ openAtLogin: !cur });
      rebuildTray();
    } },
    { type: 'separator' },
    { label: 'Atalho: Ctrl+Alt+T inicia/pausa', enabled: false },
    { label: 'Versão ' + app.getVersion(), enabled: false },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(status === 'Nenhuma sessão rodando' ? 'Timer de Sessões' : 'Timer de Sessões — ' + status.replace(/^([●⏸] )/, ''));
}

function toggleMini() {
  if (!win) return;
  miniMode = !miniMode;
  if (miniMode) {
    savedBounds = win.getBounds();
    win.setAlwaysOnTop(true, 'floating');
    win.setSize(400, 640);
  } else {
    win.setAlwaysOnTop(false);
    if (savedBounds) win.setBounds(savedBounds);
  }
  win.show();
  rebuildTray();
}

// ---- polling do estado (3s; 1s com o flutuante aberto; só re-monta a bandeja quando muda) ----
let lastHiddenPull = 0;
function startPolling() {
  const tick = async () => {
    try {
      const st = await readTimerState();
      const changed = JSON.stringify(st) !== JSON.stringify(lastState);
      lastState = st;
      if (changed) rebuildTray();
      else if (st && st.running && !st.paused) rebuildTray(); // contagem viva no tooltip
      pushFloatState();
      // Janela escondida/minimizada: visibilityState='hidden' → o poll de sync do
      // SITE (30s, gateado em visible) nunca roda e a casca não ficava sabendo de
      // pausas feitas noutro device. Cutucamos o pull por fora a cada 30s.
      if (mainAlive() && (!win.isVisible() || win.isMinimized()) && Date.now() - lastHiddenPull > 30000) {
        lastHiddenPull = Date.now();
        win.webContents.executeJavaScript(
          '(() => { try { if (document.body.classList.contains("authed") && typeof pullFromCloud === "function") pullFromCloud(); } catch (e) {} })()',
          true
        ).catch(() => {});
      }
    } catch { /* nunca matar a cadeia do poll */ }
    setTimeout(tick, floatOpen() ? 1000 : 3000);
  };
  tick();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    backgroundColor: '#0d0d0e',
    autoHideMenuBar: true,
    show: true, // mesmo no smoke: capturePage trava em janela nunca mostrada no Windows
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      partition: 'persist:timer', // login Firebase sobrevive entre aberturas
      preload: path.join(__dirname, 'preload.js'), // expõe timerDesktop.toggleFloat() pro site
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // o tick do timer não pode dormir com a janela escondida
    },
  });

  const ua = cleanUserAgent(win.webContents.getUserAgent());
  win.webContents.setUserAgent(ua);

  // Popups de login (Google/Firebase/Whoop) abrem em janela filha com a MESMA sessão;
  // links externos vão pro navegador do sistema. `about:` (Document PiP do site, se
  // escapar do intercept) morre em silêncio: permitir cria uma janela que fecha
  // sozinha; mandar pro shell.openExternal vira o diálogo da Microsoft Store.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#0d0d0e',
          webPreferences: { partition: 'persist:timer', contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Navegação do top-frame presa aos hosts confiáveis (um XSS no site não leva a
  // janela logada pra outra origem); externo vai pro navegador do sistema.
  win.webContents.on('will-navigate', (e, url) => {
    if (isTrustedUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // O clique no "Modo flutuante" do site é interceptado em fase de CAPTURA (o
  // stopPropagation impede o handler do site de chamar o Document PiP quebrado)
  // e vira o flutuante nativo. Injetado no dom-ready (did-finish-load espera
  // fontes/beacon e deixava janela pro clique escapar) E no did-finish-load
  // (idempotente via flag, que zera sozinha a cada navegação).
  const injectPipIntercept = () => {
    if (!mainAlive()) return;
    win.webContents.executeJavaScript(
      '(() => { if (window.__timerDesktopPip) return; window.__timerDesktopPip = true;' +
      ' document.addEventListener("click", (e) => {' +
      '   const b = e.target && e.target.closest && e.target.closest("#pipBtn");' +
      '   if (b && window.timerDesktop) { e.stopPropagation(); e.preventDefault(); window.timerDesktop.toggleFloat(); }' +
      ' }, true); })()',
      true
    ).catch(() => {});
    // reload do site redesenha o rótulo default — re-sincroniza com o flutuante
    if (floatOpen()) setPipBtnLabel(true);
  };
  win.webContents.on('dom-ready', injectPipIntercept);
  win.webContents.on('did-finish-load', injectPipIntercept);

  // Falha de load (DNS do roteador de casa é instável): re-tenta a cada 5s.
  // -3 = ABORTED (navegação substituída), não é falha real.
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    setTimeout(() => { if (mainAlive()) win.loadURL(APP_URL, { userAgent: ua }); }, 5000);
  });

  // Renderer morto (já aconteceu neste projeto) não pode deixar a casca zumbi
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    setTimeout(() => { if (mainAlive()) win.webContents.reload(); }, 1000);
  });

  // Fechar esconde (timer segue na bandeja); sair de verdade só pelo menu da bandeja
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

  // Auto-PiP: sair de vista com sessão rodando mostra o flutuante; voltar, esconde
  win.on('minimize', autoShowFloat);
  win.on('hide', autoShowFloat);
  win.on('restore', autoHideFloat);
  win.on('show', autoHideFloat);

  win.loadURL(APP_URL, { userAgent: ua });

  if (SMOKE) {
    // failsafe: nunca deixar o smoke pendurado
    setTimeout(() => { console.log('SMOKE {"erro":"timeout 45s"}'); quitting = true; app.quit(); }, 45000);
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 4000));
      const info = await win.webContents.executeJavaScript(
        '({ title: document.title, temGate: !!document.getElementById("authGate"), temTimer: !!document.getElementById("startBtn"), ua: navigator.userAgent })',
        true
      ).catch((e) => ({ erro: String(e) }));
      info.hotkeyRegistrado = globalShortcut.isRegistered('Control+Alt+T');
      info.versao = app.getVersion();
      // Clique REAL (sendInputEvent; dispatchEvent sintético não carrega user
      // activation e não representa o gesto do usuário). O portão de login é
      // escondido só nesta sessão de smoke (userData isolado) pro clique chegar,
      // e o #pipBtn só existe na vista de sessão RODANDO — inicia uma antes.
      const clicaReal = async (sel) => {
        const rect = await win.webContents.executeJavaScript(
          '(() => { document.body.classList.add("authed");' +
          ' const g = document.getElementById("authGate"); if (g) g.style.display = "none";' +
          ' document.querySelectorAll("[inert]").forEach((el) => el.removeAttribute("inert"));' +
          ' const b = document.querySelector(' + JSON.stringify(sel) + '); if (!b) return null;' +
          ' b.scrollIntoView({ block: "center" });' +
          ' const r = b.getBoundingClientRect(); if (!r.width && !r.height) return null;' +
          ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()',
          true
        ).catch(() => null);
        if (!rect) return false;
        win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        return true;
      };
      info.iniciouSessao = await clicaReal('#startBtn');
      await new Promise((r) => setTimeout(r, 1200));
      info.cliqueBtn = await clicaReal('#pipBtn');
      await new Promise((r) => setTimeout(r, 2000));
      info.float = floatOpen()
        ? {
            abriu: true,
            alwaysOnTop: floatWin.isAlwaysOnTop(),
            tempo: await floatWin.webContents.executeJavaScript(
              'document.getElementById("time").textContent', true
            ).catch((e) => 'erro: ' + String(e)),
            categoria: await floatWin.webContents.executeJavaScript(
              'document.getElementById("cat").textContent', true
            ).catch(() => null),
            print: await floatWin.webContents.capturePage().then((img) => {
              const p = path.join(app.getPath('temp'), 'timer-float-smoke.png');
              fs.writeFileSync(p, img.toPNG());
              return p;
            }).catch((e) => 'falhou: ' + e.message),
            rotuloBtnSite: await win.webContents.executeJavaScript(
              '(document.getElementById("pipBtn")||{}).textContent || null', true
            ).catch(() => null),
          }
        : { abriu: false };
      // pausar pela JANELINHA tem que refletir no site
      if (floatOpen()) {
        await floatWin.webContents.executeJavaScript('document.getElementById("pauseBtn").click()', true).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        info.pausouPelaJanelinha = await win.webContents.executeJavaScript('!!state.paused', true).catch(() => 'erro');
      }
      // segundo clique no botão do site deve FECHAR (toggle)
      await clicaReal('#pipBtn');
      await new Promise((r) => setTimeout(r, 800));
      info.floatFechouNoToggle = !floatOpen();
      // auto-PiP: minimizar com sessão rodando abre o flutuante sozinho; restaurar fecha
      lastState = await readTimerState();
      win.minimize();
      await new Promise((r) => setTimeout(r, 1500)); // 1ª janela transparente compila shader — 800ms flakeava
      info.autoAbriuAoMinimizar = { open: floatOpen(), visivel: floatOpen() && floatWin.isVisible(), minimizada: win.isMinimized() };
      win.restore();
      await new Promise((r) => setTimeout(r, 1000));
      info.autoFechouAoRestaurar = !floatOpen();
      // flutuante MANUAL sobrevive ao minimizar (só o automático fecha ao restaurar)
      toggleFloat();
      await new Promise((r) => setTimeout(r, 600));
      win.minimize();
      await new Promise((r) => setTimeout(r, 400));
      const sobreviveuMin = floatOpen() && floatWin.isVisible();
      win.restore();
      await new Promise((r) => setTimeout(r, 600));
      info.manualSobrevive = sobreviveuMin && floatOpen();
      if (floatOpen()) floatWin.close();
      info.trace = smokeTrace.slice(-12);
      try {
        const img = await win.webContents.capturePage();
        const out = path.join(app.getPath('temp'), 'timer-smoke.png');
        fs.writeFileSync(out, img.toPNG());
        info.screenshot = out + ' (' + img.getSize().width + 'x' + img.getSize().height + ')';
      } catch (e) { info.screenshot = 'falhou: ' + e.message; }
      console.log('SMOKE ' + JSON.stringify(info));
      quitting = true;
      app.quit();
    });
  }
}

app.whenReady().then(async () => {
  // O service worker do PWA derruba o renderer no Electron 43 (IPC inválida do
  // CacheStorage) e nem faz falta aqui: o site carrega ao vivo e o HTTP cache cobre.
  const ses = session.fromPartition('persist:timer');
  ses.webRequest.onBeforeRequest({ urls: ['https://timer.gnoronha.app/service-worker.js*'] },
    (details, cb) => cb({ cancel: true }));
  await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
  createWindow();
  tray = new Tray(trayIcon());
  tray.on('click', () => (win.isVisible() ? win.hide() : (win.show(), win.focus())));
  rebuildTray();
  // debounce: apertar 2x rápido "pra garantir" alternava pausa→retomada
  let lastHotkey = 0;
  globalShortcut.register('Control+Alt+T', () => {
    const t = Date.now();
    if (t - lastHotkey < 400) return;
    lastHotkey = t;
    toggleStartPause();
  });
  startPolling();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { /* vive na bandeja */ });
