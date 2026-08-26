'use strict';

// Sanity-check the electron-builder output: the engine and its patched
// dependencies made it in, and nothing private (session, tokens, reports,
// dev tooling) did. Run by `npm run dist`; exits non-zero on any failure.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = process.argv[2] || path.join(ROOT, 'dist', 'mac-arm64', 'WhatsThat.app');
const RES = path.join(APP, 'Contents', 'Resources', 'app');

const failures = [];
const check = (ok, msg) => (ok ? console.log(`  ✓ ${msg}`) : failures.push(msg));
const exists = (rel) => fs.existsSync(path.join(RES, rel));

console.log(`Verifying ${APP}`);
check(fs.existsSync(APP), 'app bundle exists');
if (!fs.existsSync(APP)) {
  console.error('  ✗ nothing to verify');
  process.exit(1);
}

// Engine present
for (const rel of ['server.js', 'app/main.js', 'scripts/run-due.js', 'public/index.html', 'src/whatsapp.js', 'src/datadir.js', 'src/browser.js', 'package.json']) {
  check(exists(rel), `bundled: ${rel}`);
}
for (const dep of ['whatsapp-web.js', 'puppeteer', 'puppeteer-core', '@puppeteer/browsers', 'express', '@googleapis/sheets', 'qrcode']) {
  check(exists(path.join('node_modules', dep, 'package.json')), `dependency: ${dep}`);
}
const utils = path.join(RES, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
check(fs.existsSync(utils) && fs.readFileSync(utils, 'utf8').includes('getAlternateUserWid'), 'whatsapp-web.js patch survived (getAlternateUserWid)');
check(!exists('scripts/launch.js'), 'launch-time updater NOT bundled (engine is pinned)');

// Nothing private or dev-only
const forbidden = ['.wwebjs_auth', '.wwebjs_cache', 'reports', 'test', 'patches-retired', 'node_modules/electron', 'node_modules/electron-builder', 'node_modules/patch-package', 'node_modules/googleapis', '.git'];
for (const rel of forbidden) check(!exists(rel), `absent: ${rel}`);
const localJson = fs.readdirSync(RES).filter((f) => f.endsWith('.local.json'));
check(localJson.length === 0, `no *.local.json at app root${localJson.length ? ` (found ${localJson.join(', ')})` : ''}`);

// Bundle identity + signature
try {
  const plist = fs.readFileSync(path.join(APP, 'Contents', 'Info.plist'), 'utf8');
  check(plist.includes('<string>net.whatsthat.app</string>'), 'CFBundleIdentifier is net.whatsthat.app');
  check(plist.includes('<string>WhatsThat</string>'), 'bundle name is WhatsThat');
  check(fs.existsSync(path.join(APP, 'Contents', 'Resources', 'icon.icns')), 'icon.icns present');
} catch (err) {
  failures.push(`Info.plist unreadable: ${err.message}`);
}
try {
  const out = execFileSync('codesign', ['-dv', '--verbose=1', APP], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  check(true, `codesign: ${out.split('\n').find((l) => l.startsWith('Signature')) || 'signed'}`);
} catch (err) {
  const msg = String(err.stderr || err.message);
  if (/Signature=adhoc/.test(msg)) check(true, 'codesign: ad-hoc signature');
  else failures.push(`codesign -dv failed: ${msg.trim().split('\n')[0]}`);
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ build looks right');
