'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduleStore, agentPlistXml, MAX_LATENESS_MS, STALE_RUNNING_MS } = require('../src/schedule');

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
});
