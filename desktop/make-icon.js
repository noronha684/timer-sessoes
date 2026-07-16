// Gera build/icon.ico a partir do icon.png (o NSIS/electron-builder exige .ico no Windows)
const fs = require('fs');
const path = require('path');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

(async () => {
  const out = path.join(__dirname, 'build', 'icon.ico');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const buf = await pngToIco(path.join(__dirname, 'icon.png'));
  fs.writeFileSync(out, buf);
  console.log('icon.ico gerado (' + buf.length + ' bytes)');
})().catch((e) => { console.error(e); process.exit(1); });
