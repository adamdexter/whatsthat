'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { checkAndUpdate } = require('../src/update');

let root;

// A fake project tree: node_modules/whatsapp-web.js at `installed`, optionally
// a patches/ file pinned to that version.
function makeTree({ installed = '1.34.7', patch = false } = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-update-'));
  const pkgDir = path.join(root, 'node_modules', 'whatsapp-web.js');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'whatsapp-web.js', version: installed }));
  if (patch) {
    fs.mkdirSync(path.join(root, 'patches'));
    fs.writeFileSync(path.join(root, 'patches', `whatsapp-web.js+${installed}.patch`), 'fake diff');
  }
  return root;
}

// exec fake: `view` answers with `latest`; `install` rewrites the installed
// package.json (like npm would) unless told to fail.
function fakeExec({ latest, installFails = false, calls }) {
  return async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'view') {
      if (latest instanceof Error) throw latest;
      return latest;
    }
    if (args[0] === 'install') {
      if (installFails) throw new Error('EAI_AGAIN registry.npmjs.org');
      const version = args[1].split('@')[1];
      const pkgFile = path.join(root, 'node_modules', 'whatsapp-web.js', 'package.json');
      fs.writeFileSync(pkgFile, JSON.stringify({ name: 'whatsapp-web.js', version }));
      return '';
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
  };
}

const readRecord = () => JSON.parse(fs.readFileSync(path.join(root, 'update.local.json'), 'utf8'));

beforeEach(() => {
  root = null;
});

test('no-op when already on the latest version', async () => {
  makeTree();
  const calls = [];
  const result = await checkAndUpdate({ rootDir: root, exec: fakeExec({ latest: '1.34.7', calls }) });
  assert.equal(result.updated, false);
  assert.equal(result.installed, '1.34.7');
  assert.deepEqual(calls, ['view whatsapp-web.js version']);
  assert.equal(readRecord().updated, false);
});

test('updates and retires the version-pinned patch', async () => {
  makeTree({ patch: true });
  const calls = [];
  const result = await checkAndUpdate({ rootDir: root, exec: fakeExec({ latest: '1.34.8', calls }) });
  assert.equal(result.updated, true);
  assert.equal(result.previous, '1.34.7');
  assert.equal(result.installed, '1.34.8');
  assert.equal(result.patchRetired, true);
  assert.ok(!fs.existsSync(path.join(root, 'patches', 'whatsapp-web.js+1.34.7.patch')), 'patch removed from patches/');
  assert.ok(fs.existsSync(path.join(root, 'patches-retired', 'whatsapp-web.js+1.34.7.patch')), 'patch kept in patches-retired/');
  assert.ok(calls.includes('install whatsapp-web.js@1.34.8'));
});

test('updates without a patch present', async () => {
  makeTree();
  const calls = [];
  const result = await checkAndUpdate({ rootDir: root, exec: fakeExec({ latest: '1.35.0', calls }) });
  assert.equal(result.updated, true);
  assert.equal(result.patchRetired, false);
});

test('registry unreachable: keeps the installed version, records the error', async () => {
  makeTree({ patch: true });
  const calls = [];
  const result = await checkAndUpdate({ rootDir: root, exec: fakeExec({ latest: new Error('timed out'), calls }) });
  assert.equal(result.updated, undefined);
  assert.match(result.error, /registry check failed/);
  assert.ok(fs.existsSync(path.join(root, 'patches', 'whatsapp-web.js+1.34.7.patch')), 'patch untouched');
  assert.match(readRecord().error, /timed out/);
});

test('install failure: restores the retired patch, keeps the installed version', async () => {
  makeTree({ patch: true });
  const calls = [];
  const result = await checkAndUpdate({ rootDir: root, exec: fakeExec({ latest: '1.34.8', installFails: true, calls }) });
  assert.equal(result.updated, false);
  assert.match(result.error, /install failed/);
  assert.ok(fs.existsSync(path.join(root, 'patches', 'whatsapp-web.js+1.34.7.patch')), 'patch restored to patches/');
  assert.ok(!fs.existsSync(path.join(root, 'patches-retired', 'whatsapp-web.js+1.34.7.patch')), 'no orphan in patches-retired/');
});

test('skips entirely while a scheduled send is running', async () => {
  makeTree();
  fs.writeFileSync(
    path.join(root, 'schedule.local.json'),
    JSON.stringify({ campaigns: [{ id: 'x', status: 'running' }] })
  );
  const calls = [];
  const result = await checkAndUpdate({ rootDir: root, exec: fakeExec({ latest: '1.34.8', calls }) });
  assert.equal(result.skipped, 'scheduled send in progress');
  assert.deepEqual(calls, [], 'no npm commands at all');
});
