// Fotógrafo da Store: loga com a conta de teste (dados de demonstração) e captura
// screenshots reais do app em 1600x900 pra listing do Partner Center.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'timer-shots')); // perfil próprio (não toca no app instalado)

const OUT = path.join(__dirname, 'store-shots');
const EMAIL = 'store-tester@gnoronha.app';
const SENHA = 'Timer-G2VjBRwbcxYB-2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1600, height: 900, useContentSize: true, show: true,
    backgroundColor: '#0d0d0e', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:shots', contextIsolation: true, nodeIntegration: false },
  });
  const ua = win.webContents.getUserAgent().replace(/\sElectron\/\S+/i, '').replace(/\sTimerdeSess\S+/i, '');
  win.webContents.setUserAgent(ua);
  await win.loadURL('https://timer.gnoronha.app');
  await sleep(4000);

  // login e-mail/senha pelo formulário real
  const logado = await win.webContents.executeJavaScript(
    '(async () => {' +
    ' const em = document.getElementById("agEmail") || document.querySelector("#authGate input[type=email]");' +
    ' const pw = document.getElementById("agPass") || document.querySelector("#authGate input[type=password]");' +
    ' if (!em || !pw) return "campos-nao-encontrados";' +
    ' const set = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };' +
    ' set(em, ' + JSON.stringify(EMAIL) + '); set(pw, ' + JSON.stringify(SENHA) + ');' +
    ' const btn = document.getElementById("agEntrar") || [...document.querySelectorAll("#authGate button")].find(b => /entrar/i.test(b.textContent) && !/google/i.test(b.textContent));' +
    ' if (!btn) return "botao-nao-encontrado"; btn.click(); return "clicou"; })()',
    true
  );
  console.log('login:', logado);
  await sleep(9000); // auth + primeiro pull do snapshot

  const authed = await win.webContents.executeJavaScript('document.body.classList.contains("authed")', true);
  console.log('authed:', authed);
  if (!authed) { console.log('SHOTS {"erro":"nao logou"}'); app.exit(1); return; }

  const shot = async (nome) => {
    await sleep(1200);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, nome + '.png'), img.toPNG());
    console.log('shot:', nome, JSON.stringify(img.getSize()));
  };
  const aba = async (panel) => {
    await win.webContents.executeJavaScript(
      '(() => { const t = document.querySelector(\'.tab[data-panel="' + panel + '"]\'); if (t) t.click(); return !!t; })()', true);
    await sleep(1500);
  };

  // 1) Timer com sessão rodando (preset 50) + flutuante fora da foto
  await win.webContents.executeJavaScript(
    '(() => { const p = document.querySelector(".preset-pill[data-preset=\\"50\\"]"); if (p) p.click();' +
    ' const b = document.getElementById("startBtn"); if (b) b.click(); })()', true);
  await sleep(2500);
  await shot('1-timer-rodando');

  // 2) Histórico (heatmap + totais)
  await aba('history');
  await shot('2-historico-heatmap');

  // 3) Plano semanal
  await aba('plano');
  await shot('3-plano');

  // 4) Calendário
  await aba('cal');
  await shot('4-calendario');

  // encerra a sessão de demonstração (não deixar timer fantasma na conta de teste)
  await win.webContents.executeJavaScript(
    '(() => { const t = document.querySelector(\'.tab[data-panel="timer"]\'); if (t) t.click(); })()', true);
  await sleep(800);
  await win.webContents.executeJavaScript(
    '(() => { const s = document.getElementById("stopBtn"); if (s) s.click(); const d = document.getElementById("dismissAlert"); if (d) d.click(); })()', true);
  await sleep(2500);
  console.log('SHOTS {"ok":true,"dir":' + JSON.stringify(OUT) + '}');
  app.exit(0);
});
setTimeout(() => { console.log('SHOTS {"erro":"timeout"}'); app.exit(1); }, 90000);
