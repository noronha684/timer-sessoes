const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const root = __dirname;
const source = PNG.sync.read(fs.readFileSync(path.join(root, 'icon.png')));
const outputDir = path.join(root, 'build', 'appx');

function sample(x, y, channel) {
  const sx = Math.max(0, Math.min(source.width - 1, x));
  const sy = Math.max(0, Math.min(source.height - 1, y));
  return source.data[(sy * source.width + sx) * 4 + channel];
}

function drawScaled(target, left, top, width, height) {
  for (let y = 0; y < height; y += 1) {
    const sourceY = ((y + 0.5) * source.height / height) - 0.5;
    const y0 = Math.floor(sourceY);
    const y1 = y0 + 1;
    const fy = sourceY - y0;

    for (let x = 0; x < width; x += 1) {
      const sourceX = ((x + 0.5) * source.width / width) - 0.5;
      const x0 = Math.floor(sourceX);
      const x1 = x0 + 1;
      const fx = sourceX - x0;
      const offset = ((top + y) * target.width + left + x) * 4;

      for (let channel = 0; channel < 4; channel += 1) {
        const topValue = sample(x0, y0, channel) * (1 - fx) + sample(x1, y0, channel) * fx;
        const bottomValue = sample(x0, y1, channel) * (1 - fx) + sample(x1, y1, channel) * fx;
        target.data[offset + channel] = Math.round(topValue * (1 - fy) + bottomValue * fy);
      }
    }
  }
}

function createAsset(fileName, canvasWidth, canvasHeight, iconSize) {
  const image = new PNG({ width: canvasWidth, height: canvasHeight, colorType: 6 });
  image.data.fill(0);
  const left = Math.floor((canvasWidth - iconSize) / 2);
  const top = Math.floor((canvasHeight - iconSize) / 2);
  drawScaled(image, left, top, iconSize, iconSize);
  fs.writeFileSync(path.join(outputDir, fileName), PNG.sync.write(image));
}

fs.mkdirSync(outputDir, { recursive: true });
createAsset('StoreLogo.png', 50, 50, 50);
createAsset('Square44x44Logo.png', 44, 44, 44);
createAsset('Square150x150Logo.png', 150, 150, 150);
createAsset('Wide310x150Logo.png', 310, 150, 130);

console.log('Assets AppX gerados em build/appx');
