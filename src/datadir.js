'use strict';

// Where WhatsThat keeps its data, and how it moves there.
//
// Two homes exist: the repo checkout (terminal mode, historically) and
// ~/Library/Application Support/WhatsThat (the packaged Mac app). Only ONE
// WhatsApp session may exist per data dir (Chromium profile lock), so once a
// session lives in Application Support every mode follows it — see
// resolveDataDir. The one-time migration copies, verifies, and never deletes.

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_SUPPORT_NAME = 'WhatsThat';
const MARKER = '.migrated-from.json';
const ENGINE_FILE = 'engine.local.json';

const MIGRATE_FILES = ['draft.local.json', 'draft.backup.local.json', 'google.local.json', 'schedule.local.json', 'update.local.json'];
const MIGRATE_DIRS = ['.wwebjs_auth', 'reports'];
// Chromium profile locks and per-run scratch — copying them would make the
// target profile think it's open elsewhere.
const SKIP_NAMES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', '.DS_Store']);

function appSupportDir(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'Application Support', APP_SUPPORT_NAME);
}

// Precedence: explicit env → Application Support when packaged → Application
// Support when it already holds a linked session → the repo root.
function resolveDataDir({ env = process.env, rootDir, homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.WHATSTHAT_DATA_DIR) return { dir: env.WHATSTHAT_DATA_DIR, source: 'WHATSTHAT_DATA_DIR' };
  const appSupport = appSupportDir(homeDir);
  if (env.WHATSTHAT_PACKAGED === '1') return { dir: appSupport, source: 'packaged app' };
  if (exists(path.join(appSupport, '.wwebjs_auth', 'session'))) return { dir: appSupport, source: 'session lives in Application Support' };
  return { dir: rootDir, source: 'repo checkout' };
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

// Chromium writes SingletonLock as a symlink to "<host>-<pid>" while a
// profile is open. A live pid means a WhatsApp client is using this session.
function sessionLockPid(dataDir) {
  try {
    const target = fs.readlinkSync(path.join(dataDir, '.wwebjs_auth', 'session', 'SingletonLock'));
    const m = target.match(/-(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function walk(dir, filter, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!filter(entry.name)) continue;
    const r = path.join(rel, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter, r));
    else if (entry.isFile()) out.push({ rel: r, size: fs.statSync(full).size });
  }
  return out;
}

// Copy a directory tree into place atomically: stage as <name>.migrating,
// verify every source file arrived with the same size, then rename.
function copyDirVerified(src, dest, log) {
  const staging = `${dest}.migrating`;
  fs.rmSync(staging, { recursive: true, force: true });
  const keep = (name) => !SKIP_NAMES.has(name);
  fs.cpSync(src, staging, {
    recursive: true,
    dereference: false,
    filter: (p) => keep(path.basename(p)),
  });
  const missing = walk(src, keep).filter(({ rel, size }) => {
    try {
      return fs.statSync(path.join(staging, rel)).size !== size;
    } catch {
      return true;
    }
  });
  if (missing.length) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`${missing.length} file(s) did not copy cleanly from ${src} (first: ${missing[0].rel})`);
  }
  fs.renameSync(staging, dest);
  log(`  copied ${path.basename(src)}/`);
}

function copyJsonVerified(src, dest, log) {
  const tmp = `${dest}.tmp`;
  fs.copyFileSync(src, tmp);
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // corrupt copy ⇒ throws before it lands
  fs.renameSync(tmp, dest);
  log(`  copied ${path.basename(src)}`);
}

// Returns { migrated: false, reason } when there is nothing to do, or
// { migrated: true, from, to, copied, skipped }. Throws only when the source
// is in use (the caller decides whether that is fatal). Never overwrites a
// target that already exists and never deletes the source.
function migrateData({ from, to, log = () => {} } = {}) {
  if (!from || !to) return { migrated: false, reason: 'no source/target' };
  from = path.resolve(from);
  to = path.resolve(to);
  if (from === to) return { migrated: false, reason: 'same directory' };
  const marker = path.join(to, MARKER);
  const previous = readJson(marker);
  if (previous) return { migrated: false, reason: 'already migrated', marker: previous };
  if (!fs.existsSync(from)) return { migrated: false, reason: 'source missing' };

  const present = [...MIGRATE_DIRS, ...MIGRATE_FILES].filter((n) => fs.existsSync(path.join(from, n)));
  if (!present.length) return { migrated: false, reason: 'nothing to migrate' };

  const lockPid = sessionLockPid(from);
  if (lockPid && pidAlive(lockPid)) throw new Error(`the WhatsApp session in ${from} is in use by pid ${lockPid} — quit that WhatsThat first`);
  const schedule = readJson(path.join(from, 'schedule.local.json'));
  const campaigns = Array.isArray(schedule) ? schedule : schedule?.campaigns || [];
  if (campaigns.some((c) => c && c.status === 'running')) throw new Error('a scheduled send is running from the old data directory — wait for it to finish');

  fs.mkdirSync(to, { recursive: true });
  log(`Moving WhatsThat data: ${from} → ${to}`);
  const copied = [];
  const skipped = [];
  for (const name of present) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) {
      skipped.push(name);
      log(`  kept existing ${name}`);
      continue;
    }
    if (MIGRATE_DIRS.includes(name)) copyDirVerified(src, dest, log);
    else copyJsonVerified(src, dest, log);
    copied.push(name);
  }
  const result = { from, to, at: new Date().toISOString(), copied, skipped };
  fs.writeFileSync(marker, JSON.stringify(result, null, 2));
  log('Done — the old copies were left in place.');
  return { migrated: true, ...result };
}

// engine.local.json: who is serving this data dir right now. Written by the
// engine once its port is won, removed on clean exit. Lets the app shell
// attach, lets run-due.js find an ephemeral port, and lets a second engine
// notice a live one on another port.
const engineFile = (dataDir) => path.join(dataDir, ENGINE_FILE);

function readEngineInfo(dataDir) {
  const info = readJson(engineFile(dataDir));
  return info && Number.isInteger(info.pid) ? info : null;
}

function writeEngineInfo(dataDir, info) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(engineFile(dataDir), JSON.stringify(info, null, 2), { mode: 0o600 });
}

function updateEngineInfo(dataDir, patch) {
  const current = readEngineInfo(dataDir);
  if (!current || current.pid !== process.pid) return;
  writeEngineInfo(dataDir, { ...current, ...patch });
}

function removeEngineInfo(dataDir, pid = process.pid) {
  const current = readEngineInfo(dataDir);
  if (current && current.pid !== pid) return;
  try {
    fs.unlinkSync(engineFile(dataDir));
  } catch {
    /* already gone */
  }
}

module.exports = {
  APP_SUPPORT_NAME,
  MARKER,
  ENGINE_FILE,
  appSupportDir,
  resolveDataDir,
  migrateData,
  pidAlive,
  sessionLockPid,
  readEngineInfo,
  writeEngineInfo,
  updateEngineInfo,
  removeEngineInfo,
};
