'use strict';

// Chrome resolution order (src/browser.js): env override → data dir →
// puppeteer's cache → download. All file-system and download seams injected.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { ensureBrowser, expectedBuildId } = require('../src/browser');

const dataDir = '/data/WhatsThat';
const home = '/Users/me';
const buildId = '146.0.7680.31';
const computeExecutablePath = ({ cacheDir, buildId: b }) => path.join(cacheDir, `chrome-${b}`, 'chrome');
const neverInstall = async () => {
  throw new Error('install must not be called');
};
const base = { dataDir, homeDir: home, buildId, computeExecutablePath, install: neverInstall, env: {} };

test('expectedBuildId comes from puppeteer-core', () => {
  assert.match(expectedBuildId(), /^\d+\.\d+\.\d+\.\d+$/);
});

test('WHATSTHAT_CHROME wins and never downloads', async () => {
  const r = await ensureBrowser({ ...base, env: { WHATSTHAT_CHROME: '/Apps/Chromium' }, exists: () => true });
  assert.deepEqual(r, { executablePath: '/Apps/Chromium', source: 'env', buildId: null });
});

test('WHATSTHAT_CHROME pointing nowhere is an error, not a fall-through', async () => {
  await assert.rejects(ensureBrowser({ ...base, env: { WHATSTHAT_CHROME: '/nope' }, exists: () => false }), /WHATSTHAT_CHROME points to a missing file/);
});

test('a copy in the data dir wins over puppeteer\'s cache', async () => {
  const r = await ensureBrowser({ ...base, exists: () => true });
  assert.equal(r.source, 'data-dir');
  assert.equal(r.executablePath, path.join(dataDir, 'chromium', `chrome-${buildId}`, 'chrome'));
});

test('puppeteer\'s own cache is used when present (PUPPETEER_CACHE_DIR honoured)', async () => {
  const r = await ensureBrowser({ ...base, exists: (p) => p.startsWith(path.join(home, '.cache', 'puppeteer')) });
  assert.equal(r.source, 'puppeteer-cache');
  const custom = await ensureBrowser({ ...base, env: { PUPPETEER_CACHE_DIR: '/pc' }, exists: (p) => p.startsWith('/pc') });
  assert.equal(custom.source, 'puppeteer-cache');
  assert.ok(custom.executablePath.startsWith('/pc'));
});

test('downloads into <dataDir>/chromium when nothing is present, with monotonic progress', async () => {
  const progress = [];
  let installArgs;
  const install = async (args) => {
    installArgs = args;
    for (let i = 0; i <= 10; i++) args.downloadProgressCallback(i * 10, 100);
    return { executablePath: path.join(args.cacheDir, 'dl', 'chrome') };
  };
  const r = await ensureBrowser({ ...base, install, exists: () => false, onProgress: (pct) => progress.push(pct) });
  assert.equal(r.source, 'downloaded');
  assert.equal(installArgs.cacheDir, path.join(dataDir, 'chromium'));
  assert.equal(installArgs.buildId, buildId);
  assert.equal(installArgs.browser, 'chrome');
  assert.ok(progress.length >= 2, 'reported progress');
  assert.equal(progress[progress.length - 1], 100);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] > progress[i - 1], 'monotonic');
});

test('a failed download surfaces its error', async () => {
  const install = async () => {
    throw new Error('ENOSPC: no space left');
  };
  await assert.rejects(ensureBrowser({ ...base, install, exists: () => false }), /ENOSPC/);
});
