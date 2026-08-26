'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduleStore, agentPlistXml, agentSpec, ensureAgent, uninstallAgent, MAX_LATENESS_MS, STALE_RUNNING_MS } = require('../src/schedule');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-sched-'));
  return createScheduleStore(path.join(dir, 'schedule.local.json'));
}

const CONTACTS = [{ id: 1, fields: { firstName: 'Ada' }, phone: '+14155550134', phoneError: null }];

test('add / list / cancel lifecycle', () => {
  const s = tmpStore();
  const c = s.add({ sendAt: new Date(Date.now() + 3600000).toISOString(), contacts: CONTACTS, template: 'Hi {{firstName}}', delayMinMs: 1, delayMaxMs: 2 });
  assert.equal(c.status, 'pending');
  assert.equal(s.list().length, 1);
  const cancelled = s.cancel(c.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(s.cancel(c.id), null); // can't cancel twice
});

test('findDue returns only due pending campaigns', () => {
  const s = tmpStore();
  const past = s.add({ sendAt: new Date(Date.now() - 60000).toISOString(), contacts: CONTACTS, template: 'x' });
  s.add({ sendAt: new Date(Date.now() + 3600000).toISOString(), contacts: CONTACTS, template: 'future' });
  const due = s.findDue();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, past.id);
});

test('overdue beyond the lateness window is marked missed, not sent', () => {
  const s = tmpStore();
  const stale = s.add({ sendAt: new Date(Date.now() - MAX_LATENESS_MS - 60000).toISOString(), contacts: CONTACTS, template: 'x' });
  const due = s.findDue();
  assert.equal(due.length, 0);
  assert.equal(s.get(stale.id).status, 'missed');
  assert.match(s.get(stale.id).error, /unavailable/);
});

test('stale running campaigns are marked failed (interrupted)', () => {
  const s = tmpStore();
  const c = s.add({ sendAt: new Date().toISOString(), contacts: CONTACTS, template: 'x' });
  s.patch(c.id, { status: 'running', startedAt: new Date(Date.now() - STALE_RUNNING_MS - 60000).toISOString() });
  s.findDue();
  assert.equal(s.get(c.id).status, 'failed');
  assert.match(s.get(c.id).error, /interrupted/);
});

test('fresh running campaigns are left alone', () => {
  const s = tmpStore();
  const c = s.add({ sendAt: new Date().toISOString(), contacts: CONTACTS, template: 'x' });
  s.patch(c.id, { status: 'running', startedAt: new Date().toISOString() });
  s.findDue();
  assert.equal(s.get(c.id).status, 'running');
});

test('agent plist is valid and escapes paths', () => {
  const xml = agentPlistXml({ nodePath: '/usr/local/bin/node', scriptPath: '/Users/x & y/run-due.js', logPath: '/tmp/s.log', intervalSec: 120 });
  assert.match(xml, /<key>Label<\/key><string>net\.whatsthat\.scheduler<\/string>/);
  assert.match(xml, /<key>StartInterval<\/key><integer>120<\/integer>/);
  assert.ok(xml.includes('/Users/x &amp; y/run-due.js'));
  assert.ok(!xml.includes('x & y')); // raw ampersand must not survive
  assert.ok(!xml.includes('EnvironmentVariables'), 'no env block unless asked');
});

test('agent plist carries the environment launchd would otherwise drop', () => {
  const xml = agentPlistXml({
    nodePath: '/Applications/WhatsThat.app/Contents/MacOS/WhatsThat',
    scriptPath: '/Applications/WhatsThat.app/Contents/Resources/app/scripts/run-due.js',
    logPath: '/Users/x/Library/Application Support/WhatsThat/scheduler.log',
    env: { ELECTRON_RUN_AS_NODE: '1', WHATSTHAT_DATA_DIR: '/Users/x & y/AS' },
  });
  assert.match(xml, /<key>EnvironmentVariables<\/key>\s*<dict>/);
  assert.ok(xml.includes('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>'));
  assert.ok(xml.includes('<key>WHATSTHAT_DATA_DIR</key><string>/Users/x &amp; y/AS</string>'));
});

test('agentSpec: packaged runs the app binary as node with the data dir spelled out', () => {
  const pk = agentSpec({ rootDir: '/App/Contents/Resources/app', dataDir: '/AS', packaged: true, execPath: '/App/Contents/MacOS/WhatsThat', env: {}, port: 3847 });
  assert.equal(pk.nodePath, '/App/Contents/MacOS/WhatsThat');
  assert.equal(pk.scriptPath, '/App/Contents/Resources/app/scripts/run-due.js');
  assert.equal(pk.logPath, '/AS/logs/scheduler.log');
  assert.deepEqual(pk.env, { WHATSTHAT_DATA_DIR: '/AS', PORT: '3847', ELECTRON_RUN_AS_NODE: '1', WHATSTHAT_PACKAGED: '1' });
  const dev = agentSpec({ rootDir: '/repo', env: { WHATSTHAT_CHROME: '/x/chrome' } });
  assert.notEqual(dev.nodePath, '/App/Contents/MacOS/WhatsThat');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in dev.env));
  assert.equal(dev.env.WHATSTHAT_CHROME, '/x/chrome');
  assert.equal(dev.logPath, '/repo/logs/scheduler.log');
});

test('ensureAgent installs once, no-ops when unchanged, repairs when the spec moves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-agent-'));
  const plistPath = path.join(dir, 'LaunchAgents', 'net.whatsthat.scheduler.plist');
  const calls = [];
  const exec = (args) => calls.push(args[0]);
  let loaded = false;
  const installed = () => loaded;
  const dataDir = path.join(dir, 'data');
  const spec = agentSpec({ rootDir: '/repo-a', dataDir, env: {} });

  let r = ensureAgent(spec, { exec, plistPath, installed });
  assert.deepEqual(r, { installed: true, plist: plistPath, changed: true, repaired: false });
  assert.deepEqual(calls, ['bootout', 'bootstrap']);
  assert.ok(fs.existsSync(plistPath));
  assert.ok(fs.existsSync(path.join(dataDir, 'logs')), 'log dir created for launchd (it will not create it)');
  loaded = true;

  calls.length = 0;
  r = ensureAgent(spec, { exec, plistPath, installed });
  assert.equal(r.changed, false);
  assert.deepEqual(calls, [], 'identical spec + loaded ⇒ launchctl untouched');

  r = ensureAgent(agentSpec({ rootDir: '/repo-b', dataDir, env: {} }), { exec, plistPath, installed });
  assert.equal(r.repaired, true);
  assert.deepEqual(calls, ['bootout', 'bootstrap']);
  assert.ok(fs.readFileSync(plistPath, 'utf8').includes('/repo-b/scripts/run-due.js'));

  calls.length = 0;
  loaded = false;
  r = ensureAgent(agentSpec({ rootDir: '/repo-b', dataDir, env: {} }), { exec, plistPath, installed });
  assert.equal(r.changed, true, 'same plist but not loaded ⇒ bootstrap again');
  assert.equal(r.repaired, false);

  calls.length = 0;
  r = uninstallAgent({ exec, plistPath });
  assert.equal(r.installed, false);
  assert.deepEqual(calls, ['bootout']);
  assert.ok(!fs.existsSync(plistPath));
});
