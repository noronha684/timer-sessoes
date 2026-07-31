// One-off: screenshot da seção 07 · Fechar semestre (seed do timerH2Tab via stub).
// Uso: node tests/shot-fechamento.js OUT.png
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = path.resolve(process.argv[2] || 'fechamento.png');

let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
html = html.replace(/<script type="module">[\s\S]*?<\/script>/, '');
html = html.replace(/navigator\.serviceWorker\.register\([^)]*\)/g, 'Promise.resolve()');
const stub = fs.readFileSync(path.join(__dirname, 'stub.js'), 'utf8');
html = html.replace('<head>', '<head>\n<script>' + stub + "\ntry{localStorage.setItem('timerH2Tab','fechamento')}catch(e){}</script>");
const fixture = path.join(__dirname, 'fixture.html');
fs.writeFileSync(fixture, html);

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-shot-'));
const url = 'file:///' + fixture.split(path.sep).join('/') + '?tab=semestre';
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--force-device-scale-factor=2', '--window-size=460,1400',
  '--user-data-dir=' + prof, '--virtual-time-budget=4000',
  '--screenshot=' + out, url,
], { stdio: 'pipe' });
console.log('shot:', out);
