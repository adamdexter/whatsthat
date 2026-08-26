'use strict';

// Data-dir resolution, the one-time migration, and the engine.local.json
// occupancy file (src/datadir.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dd = require('../src/datadir');

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `whatsthat-${label}-`));

test('resolveDataDir: env > packaged > session in Application Support > repo', () => {
  const home = tmp('home');
  const appSupport = path.join(home, 'Library', 'Application Support', 'WhatsThat');
  assert.equal(dd.resolveDataDir({ env: { WHATSTHAT_DATA_DIR: '/x' }, rootDir: '/repo', homeDir: home }).dir, '/x');
  assert.equal(dd.resolveDataDir({ env: { WHATSTHAT_PACKAGED: '1' }, rootDir: '/repo', homeDir: home }).dir, appSupport);
  assert.equal(dd.resolveDataDir({ env: {}, rootDir: '/repo', homeDir: home }).dir, '/repo');
  fs.mkdirSync(path.join(appSupport, '.wwebjs_auth', 'session'), { recursive: true });
  const followed = dd.resolveDataDir({ env: {}, rootDir: '/repo', homeDir: home });
  assert.equal(followed.dir, appSupport, 'terminal mode follows a session that moved to Application Support');
  assert.match(followed.source, /Application Support/);
  assert.equal(dd.resolveDataDir({ env: { WHATSTHAT_DATA_DIR: '/y' }, rootDir: '/repo', homeDir: home }).dir, '/y', 'env still wins');
});

function seedSource(from, { lockPid = 4194304 } = {}) {
  const session = path.join(from, '.wwebjs_auth', 'session', 'Default');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'Cookies'), 'cookie-bytes-here');
  fs.writeFileSync(path.join(session, 'Local State'), '{"profile":1}');
  fs.symlinkSync(`Mac.local-${lockPid}`, path.join(from, '.wwebjs_auth', 'session', 'SingletonLock'));
  fs.writeFileSync(path.join(from, '.wwebjs_auth', 'session', 'DevToolsActivePort'), '1234');
  fs.writeFileSync(path.join(from, 'draft.local.json'), JSON.stringify({ template: 'hi {{firstName}}' }));
  fs.writeFileSync(path.join(from, 'google.local.json'), JSON.stringify({ token: 'x' }));
  fs.writeFileSync(path.join(from, 'schedule.local.json'), JSON.stringify({ campaigns: [] }));
  fs.mkdirSync(path.join(from, 'reports'));
  fs.writeFileSync(path.join(from, 'reports', 'run-1.json'), '{"sent":1}');
  fs.mkdirSync(path.join(from, '.wwebjs_cache'));
  fs.writeFileSync(path.join(from, '.wwebjs_cache', '2.3000.html'), '<html>');
}

test('migrateData copies + verifies, skips locks and caches, marks, never deletes', () => {
  const from = tmp('from');
  const to = tmp('to');
  seedSource(from);
  const log = [];
  const r = dd.migrateData({ from, to, log: (l) => log.push(l) });
  assert.equal(r.migrated, true);
  assert.deepEqual(r.copied.sort(), ['.wwebjs_auth', 'draft.local.json', 'google.local.json', 'reports', 'schedule.local.json']);
  assert.equal(fs.readFileSync(path.join(to, '.wwebjs_auth', 'session', 'Default', 'Cookies'), 'utf8'), 'cookie-bytes-here');
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, 'draft.local.json'))).template, 'hi {{firstName}}');
  assert.equal(fs.readFileSync(path.join(to, 'reports', 'run-1.json'), 'utf8'), '{"sent":1}');
  assert.ok(!fs.existsSync(path.join(to, '.wwebjs_auth', 'session', 'SingletonLock')), 'profile lock not copied');
  assert.ok(!fs.existsSync(path.join(to, '.wwebjs_auth', 'session', 'DevToolsActivePort')), 'scratch not copied');
  assert.ok(!fs.existsSync(path.join(to, '.wwebjs_cache')), 'html cache not copied');
  assert.ok(!fs.existsSync(path.join(to, '.wwebjs_auth.migrating')), 'staging dir renamed away');
  assert.ok(fs.existsSync(path.join(from, '.wwebjs_auth', 'session', 'Default', 'Cookies')), 'source untouched');
  assert.ok(fs.existsSync(path.join(from, 'draft.local.json')), 'source untouched');
  const marker = JSON.parse(fs.readFileSync(path.join(to, dd.MARKER)));
  assert.equal(marker.from, from);
  assert.ok(log.some((l) => /copied \.wwebjs_auth/.test(l)));

  const again = dd.migrateData({ from, to });
  assert.equal(again.migrated, false);
  assert.equal(again.reason, 'already migrated');
  assert.equal(again.marker.from, from);
});

test('migrateData keeps files that already exist at the target', () => {
  const from = tmp('from');
  const to = tmp('to');
  seedSource(from);
  fs.writeFileSync(path.join(to, 'draft.local.json'), JSON.stringify({ template: 'newer' }));
  const r = dd.migrateData({ from, to });
  assert.equal(r.migrated, true);
  assert.deepEqual(r.skipped, ['draft.local.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, 'draft.local.json'))).template, 'newer');
  assert.ok(fs.existsSync(path.join(to, 'google.local.json')));
});

test('migrateData refuses while the source session is open', () => {
  const from = tmp('from');
  const to = tmp('to');
  seedSource(from, { lockPid: process.pid });
  assert.throws(() => dd.migrateData({ from, to }), /in use by pid/);
  assert.ok(!fs.existsSync(path.join(to, 'draft.local.json')), 'nothing copied');
});

test('migrateData refuses while a scheduled send is running from the source', () => {
  const from = tmp('from');
  const to = tmp('to');
  seedSource(from);
  fs.writeFileSync(path.join(from, 'schedule.local.json'), JSON.stringify({ campaigns: [{ id: 'a', status: 'running' }] }));
  assert.throws(() => dd.migrateData({ from, to }), /scheduled send is running/);
});

test('migrateData no-ops: same dir, missing source, empty source', () => {
  const dir = tmp('same');
  assert.equal(dd.migrateData({ from: dir, to: dir }).reason, 'same directory');
  assert.equal(dd.migrateData({ from: path.join(dir, 'nope'), to: tmp('to') }).reason, 'source missing');
  assert.equal(dd.migrateData({ from: tmp('empty'), to: tmp('to') }).reason, 'nothing to migrate');
});

test('sessionLockPid reads Chromium\'s SingletonLock symlink', () => {
  const dir = tmp('lock');
  assert.equal(dd.sessionLockPid(dir), null);
  fs.mkdirSync(path.join(dir, '.wwebjs_auth', 'session'), { recursive: true });
  fs.symlinkSync('Mac-mini.localdomain-2779', path.join(dir, '.wwebjs_auth', 'session', 'SingletonLock'));
  assert.equal(dd.sessionLockPid(dir), 2779);
  assert.equal(dd.pidAlive(process.pid), true);
  assert.equal(dd.pidAlive(2 ** 22 - 1), false);
});

test('engine.local.json: write/read/update/remove are pid-scoped', () => {
  const dir = tmp('engine');
  assert.equal(dd.readEngineInfo(dir), null);
  dd.writeEngineInfo(dir, { pid: process.pid, port: 4242, version: '9.9.9' });
  assert.equal(dd.readEngineInfo(dir).port, 4242);
  assert.equal((fs.statSync(path.join(dir, dd.ENGINE_FILE)).mode & 0o777).toString(8), '600');
  dd.updateEngineInfo(dir, { chromePid: 77 });
  assert.equal(dd.readEngineInfo(dir).chromePid, 77);
  dd.removeEngineInfo(dir, process.pid + 1);
  assert.ok(dd.readEngineInfo(dir), 'another pid cannot remove our file');
  dd.removeEngineInfo(dir);
  assert.equal(dd.readEngineInfo(dir), null);
  dd.writeEngineInfo(dir, { pid: process.pid + 1, port: 1 });
  dd.updateEngineInfo(dir, { chromePid: 5 });
  assert.equal(dd.readEngineInfo(dir).chromePid, undefined, 'update only touches our own file');
});
