#!/usr/bin/env node
// Harness de smoke do SITE (re-rodável — o de 20/jul vivia num scratchpad efêmero).
//   node tests/smoke.js            → roda cenários e sai 0/1
//   node tests/smoke.js --shot OUT.png [--tab history]  → só screenshot do fixture autenticado
// Monta tests/fixture.html = index.html com Firebase stubado + cenários injetados,
// e roda no Chrome headless (perfil NOVO em dir ABSOLUTO — perfil relativo/compartilhado
// já poluiu cenários com sessão restaurada de runs anteriores, cilada documentada).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function buildFixture({ scenario = true } = {}) {
  let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // Tira o módulo do Firebase real (import de vendor falha em file:// e só faz barulho;
  // o stub já entrega window._fb pronto)
  html = html.replace(/<script type="module">[\s\S]*?<\/script>/, '');
  // Tira o registro do service worker (headless não precisa e suja o log)
  html = html.replace(/navigator\.serviceWorker\.register\([^)]*\)/g, 'Promise.resolve()');
  const stub = fs.readFileSync(path.join(__dirname, 'stub.js'), 'utf8');
  html = html.replace('<head>', '<head>\n<script>/* SMOKE STUB */\n' + stub + '\n</script>');
  if (scenario) {
    const sc = fs.readFileSync(path.join(__dirname, 'scenario.js'), 'utf8');
    html = html.replace('</body>', '<script>/* SMOKE SCENARIO */\n' + sc + '\n</script>\n</body>');
  }
  const out = path.join(__dirname, 'fixture.html');
  fs.writeFileSync(out, html);
  return out;
}

function freshProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'timer-smoke-'));
}

function chromeArgs(profile) {
  return [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--force-device-scale-factor=2', '--window-size=460,900',
    '--user-data-dir=' + profile, // ABSOLUTO (relativo não resolve pelo cwd — cilada de 20/jul)
  ];
}

const args = process.argv.slice(2);
if (args[0] === '--shot') {
  const out = path.resolve(args[1] || 'shot.png');
  const tab = (() => { const i = args.indexOf('--tab'); return i >= 0 ? args[i + 1] : ''; })();
  const fixture = buildFixture({ scenario: false });
  const url = 'file:///' + fixture.replace(/\\/g, '/') + (tab ? '?tab=' + tab : '');
  execFileSync(CHROME, [...chromeArgs(freshProfile()), '--virtual-time-budget=4000', '--screenshot=' + out, url], { stdio: 'pipe' });
  console.log('screenshot:', out);
  process.exit(0);
}

const fixture = buildFixture();
const url = 'file:///' + fixture.replace(/\\/g, '/');
const dom = execFileSync(CHROME, [...chromeArgs(freshProfile()), '--virtual-time-budget=8000', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
const m = dom.match(/<div id="smokeResult">([^<]*)<\/div>/);
if (!m) { console.error('SMOKE: sem resultado (o app quebrou antes dos cenários?)'); process.exit(1); }
const r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
console.log(`SMOKE: ${r.ok ? 'OK' : 'FALHOU'} — ${r.pass} passaram${r.fail.length ? '; falhas: ' + r.fail.join(' | ') : ''}`);
process.exit(r.ok ? 0 : 1);
