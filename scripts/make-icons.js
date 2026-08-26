'use strict';

// Renders build/icon.html's canvas drawings into everything the app needs:
//   build/icon.icns            — bundle icon (via iconutil)
//   app/assets/icon.png        — Dock icon for dev mode (app.dock.setIcon)
//   app/assets/trayTemplate.png, @2x — menu-bar template image
// Runs under Electron (`npm run icons`) so no image library is needed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ASSETS = path.join(ROOT, 'app', 'assets');

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } });
    await win.loadFile(path.join(BUILD, 'icon.html'));
    const png = async (expr) => nativeImage.createFromDataURL(await win.webContents.executeJavaScript(expr)).toPNG();

    const iconset = path.join(BUILD, 'icon.iconset');
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset, { recursive: true });
    for (const base of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(iconset, `icon_${base}x${base}.png`), await png(`renderIcon(${base})`));
      fs.writeFileSync(path.join(iconset, `icon_${base}x${base}@2x.png`), await png(`renderIcon(${base * 2})`));
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);

    fs.mkdirSync(ASSETS, { recursive: true });
    fs.writeFileSync(path.join(ASSETS, 'icon.png'), await png('renderIcon(512)'));
    fs.writeFileSync(path.join(ASSETS, 'trayTemplate.png'), await png('renderTray(18)'));
    fs.writeFileSync(path.join(ASSETS, 'trayTemplate@2x.png'), await png('renderTray(36)'));

    console.log(`wrote ${path.relative(ROOT, path.join(BUILD, 'icon.icns'))}, app/assets/icon.png, app/assets/trayTemplate{,@2x}.png`);
    app.exit(0);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
