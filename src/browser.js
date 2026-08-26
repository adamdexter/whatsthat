'use strict';

// Find (or fetch) the Chrome build whatsapp-web.js's puppeteer expects.
//
// Resolution order — the first hit wins, and an explicit override that points
// nowhere is an error rather than a silent fall-through:
//   1. WHATSTHAT_CHROME                       (any Chromium-compatible binary)
//   2. <dataDir>/chromium                     (what we downloaded earlier)
//   3. ~/.cache/puppeteer (PUPPETEER_CACHE_DIR) (puppeteer's own install-time copy)
//   4. download into <dataDir>/chromium via @puppeteer/browsers
// The build id comes from puppeteer-core, so it always matches the library
// that will drive it. Chromium is never bundled in the app.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'chrome';

function expectedBuildId() {
  return require('puppeteer-core').PUPPETEER_REVISIONS.chrome;
}

function puppeteerCacheDir(env = process.env, homeDir = os.homedir()) {
  return env.PUPPETEER_CACHE_DIR || path.join(homeDir, '.cache', 'puppeteer');
}

async function ensureBrowser({
  dataDir,
  env = process.env,
  homeDir = os.homedir(),
  onProgress = () => {},
  log = () => {},
  // injectable for tests
  exists = fs.existsSync,
  buildId,
  computeExecutablePath,
  install,
} = {}) {
  if (env.WHATSTHAT_CHROME) {
    if (!exists(env.WHATSTHAT_CHROME)) throw new Error(`WHATSTHAT_CHROME points to a missing file: ${env.WHATSTHAT_CHROME}`);
    return { executablePath: env.WHATSTHAT_CHROME, source: 'env', buildId: null };
  }

  const browsers = require('@puppeteer/browsers');
  buildId = buildId || expectedBuildId();
  computeExecutablePath = computeExecutablePath || browsers.computeExecutablePath;
  install = install || browsers.install;

  const localDir = path.join(dataDir, 'chromium');
  const candidates = [
    [localDir, 'data-dir'],
    [puppeteerCacheDir(env, homeDir), 'puppeteer-cache'],
  ];
  for (const [cacheDir, source] of candidates) {
    let p;
    try {
      p = computeExecutablePath({ cacheDir, browser: CHROME, buildId });
    } catch {
      continue; // unsupported platform string etc. — try the next home
    }
    if (p && exists(p)) return { executablePath: p, source, buildId };
  }

  log(`Downloading Chrome ${buildId} into ${localDir} (one-time, ~160 MB)…`);
  let lastPct = -1;
  let lastAt = 0;
  const installed = await install({
    cacheDir: localDir,
    browser: CHROME,
    buildId,
    downloadProgressCallback: (downloaded, total) => {
      const pct = total ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;
      const now = Date.now();
      if (pct !== lastPct && (now - lastAt >= 500 || pct === 100)) {
        lastPct = pct;
        lastAt = now;
        onProgress(pct, downloaded, total);
      }
    },
  });
  if (!installed || !installed.executablePath) throw new Error('Chrome download finished but no executable was reported');
  log(`Chrome ${buildId} ready at ${installed.executablePath}`);
  return { executablePath: installed.executablePath, source: 'downloaded', buildId };
}

module.exports = { ensureBrowser, expectedBuildId, puppeteerCacheDir };
