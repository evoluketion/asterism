'use strict';

// Renders build/icon.svg to the icons the app and installers use, with Chromium so the
// gradients come out exactly as designed. Run with: npx electron scripts/render-icon.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { encodeIco } = require('./ico');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const outputs = [
  [path.join(root, 'build', 'icon.png'), 1024],
  [path.join(root, 'src', 'assets', 'icon.png'), 512],
];
// The Windows window icon. Windows picks the closest size per DPI instead of scaling one image.
const icoOutput = path.join(root, 'src', 'assets', 'icon.ico');
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const size = 1024;
  const win = new BrowserWindow({
    width: size, height: size, show: false, transparent: true, backgroundColor: '#00000000', frame: false, useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  for (const [file, px] of outputs) {
    fs.writeFileSync(file, img.resize({ width: px, height: px, quality: 'best' }).toPNG());
    console.log(`wrote ${path.relative(root, file)} (${px}px)`);
  }
  fs.writeFileSync(icoOutput, encodeIco(icoSizes.map(px => ({ size: px, png: img.resize({ width: px, height: px, quality: 'best' }).toPNG() }))));
  console.log(`wrote ${path.relative(root, icoOutput)} (${icoSizes.join(', ')}px)`);
  app.quit();
});
