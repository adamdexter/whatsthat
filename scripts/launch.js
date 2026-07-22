'use strict';

// `npm start` entry point: run the whatsapp-web.js auto-update check, then
// launch the server (which therefore always boots with the updated library —
// no separate relaunch needed). Flags pass through to server.js, so
// `npm start --fresh` and `npm start -- --fresh` both work.
// Skips: mock mode, WHATSTHAT_NO_UPDATE=1.

const path = require('path');
const { spawn } = require('child_process');
const { checkAndUpdate } = require('../src/update');

const ROOT = path.join(__dirname, '..');

(async () => {
  if (process.env.WHATSTHAT_MOCK === '1' || process.env.WHATSTHAT_NO_UPDATE === '1') {
    console.log('auto-update: skipped');
  } else {
    try {
      await checkAndUpdate({
        rootDir: ROOT,
        dataDir: process.env.WHATSTHAT_DATA_DIR || ROOT,
        log: console.log,
      });
    } catch (err) {
      console.error(`auto-update: unexpected failure (${err.message}) — starting with the installed version`);
    }
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(signal ? 0 : code ?? 0));
})();
