// Timer de Sessões — casca desktop (Electron) sobre https://timer.gnoronha.app
// O site é a verdade (atualizações chegam sozinhas); aqui só entram os poderes de desktop:
// bandeja com o tempo restante, atalho global Ctrl+Alt+T, fechar→bandeja, modo mini
// always-on-top, notificações nativas e "abrir com o Windows".
const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://timer.gnoronha.app';
const SMOKE = process.argv.includes('--smoke');

let win = null;
let tray = null;
let quitting = false;
let miniMode = false;
let savedBounds = null;
let lastState = null;

// Notificações nativas do Windows precisam do AppUserModelID casando com o instalador
app.setAppUserModelId('app.gnoronha.timer');

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
  // (o Electron injeta o productName sem espaços, ex.: "TimerdeSessões/1.0.0")
  return ua.replace(/\sElectron\/\S+/i, '').replace(/\sTimerdeSess\S+/i, '');
}

function fmtRemaining(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// ---- ponte com a página (sem tocar no site): lê o `state` global e clica nos botões ----
async function readTimerState() {
  if (!win || win.webContents.isDestroyed()) return null;
  try {
    return await win.webContents.executeJavaScript(
      '(() => { try { return { running: !!state.running, paused: !!state.paused, remainingMs: state.remainingMs|0, category: String(state.category||"") }; } catch (e) { return null; } })()',
      true
    );
  } catch { return null; }
}
function pageClick(sel) {
  if (!win || win.webContents.isDestroyed()) return;
  win.webContents.executeJavaScript(
    '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); if (el) el.click(); })()',
    true
  ).catch(() => {});
}
function startPreset(min) {
  if (!win || win.webContents.isDestroyed()) return;
  win.show();
  win.webContents.executeJavaScript(
    '(() => { try { if (state.running) return "ja-rodando";' +
    ' const p = document.querySelector(".preset-pill[data-preset=\\"' + min + '\\"]"); if (p) p.click();' +
    ' const b = document.getElementById("startBtn"); if (b) b.click(); return "ok"; } catch (e) { return String(e); } })()',
    true
  ).catch(() => {});
}
function toggleStartPause() {
  if (!win || win.webContents.isDestroyed()) return;
  win.webContents.executeJavaScript(
    '(() => { try {' +
    ' if (state.running) { const b = document.getElementById("pauseBtn"); if (b) b.click(); return state.paused ? "retomou" : "pausou"; }' +
    ' const s = document.getElementById("startBtn"); if (s) s.click(); return "iniciou";' +
    ' } catch (e) { return String(e); } })()',
    true
  ).catch(() => {});
}

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
          { label: st.paused ? 'Retomar' : 'Pausar', click: () => pageClick('#pauseBtn') },
          { label: 'Parar sessão', click: () => pageClick('#stopBtn') },
        ]
      : [
          { label: 'Iniciar 25 min', click: () => startPreset(25) },
          { label: 'Iniciar 50 min', click: () => startPreset(50) },
          { label: 'Iniciar 60 min', click: () => startPreset(60) },
        ]),
    { type: 'separator' },
    { label: 'Mostrar / ocultar', click: () => (win.isVisible() ? win.hide() : (win.show(), win.focus())) },
    { label: 'Modo mini (sempre visível)', type: 'checkbox', checked: miniMode, click: toggleMini },
    { label: 'Abrir com o Windows', type: 'checkbox', checked: login, click: () => app.setLoginItemSettings({ openAtLogin: !login }) },
    { type: 'separator' },
    { label: 'Atalho: Ctrl+Alt+T inicia/pausa', enabled: false },
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

// ---- polling do estado (leve: 3s; só atualiza a bandeja quando algo muda) ----
function startPolling() {
  setInterval(async () => {
    const st = await readTimerState();
    const changed = JSON.stringify(st) !== JSON.stringify(lastState);
    lastState = st;
    if (changed) rebuildTray();
    else if (st && st.running && !st.paused) rebuildTray(); // contagem viva no tooltip
  }, 3000);
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
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // o tick do timer não pode dormir com a janela escondida
    },
  });

  const ua = cleanUserAgent(win.webContents.getUserAgent());
  win.webContents.setUserAgent(ua);

  // Popups de login (Google/Firebase/Whoop) abrem em janela filha com a MESMA sessão;
  // qualquer outro link externo vai pro navegador do sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const trusted = /(^https:\/\/(accounts\.google\.com|.*\.firebaseapp\.com|api\.prod\.whoop\.com|timer\.gnoronha\.app|timer-sessoes\.gabriel-noronha-o-p\.workers\.dev))/.test(url);
    if (trusted) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#0d0d0e',
          webPreferences: { partition: 'persist:timer', contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Fechar esconde (timer segue na bandeja); sair de verdade só pelo menu da bandeja
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

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
      try {
        const img = await win.webContents.capturePage();
        const out = path.join(__dirname, 'smoke.png');
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
  // O service worker do PWA derruba o renderer no Electron (IPC inválida do CacheStorage)
  // e nem faz falta aqui: o site carrega ao vivo e o HTTP cache cobre. Bloqueia + limpa.
  const ses = session.fromPartition('persist:timer');
  ses.webRequest.onBeforeRequest({ urls: ['https://timer.gnoronha.app/service-worker.js*'] },
    (details, cb) => cb({ cancel: true }));
  await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }).catch(() => {});
  createWindow();
  tray = new Tray(trayIcon());
  tray.on('click', () => (win.isVisible() ? win.hide() : (win.show(), win.focus())));
  rebuildTray();
  globalShortcut.register('Control+Alt+T', toggleStartPause);
  startPolling();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { /* vive na bandeja */ });
