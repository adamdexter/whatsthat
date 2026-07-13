'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunner } = require('../src/runner');

function makeContact(id, fields, phone) {
  return { id, fields, phone: phone ?? null, phoneError: phone ? null : 'bad' };
}

function stubWa({ failCheck = [], failSend = [] } = {}) {
  const sent = [];
  return {
    sent,
    async checkNumber(e164) {
      if (failCheck.includes(e164)) return null;
      return `${e164.replace('+', '')}@c.us`;
    },
    async send(chatId, text) {
      if (failSend.some((n) => chatId.startsWith(n.replace('+', '')))) throw new Error('boom');
      sent.push({ chatId, text });
    },
  };
}

function tmpReports() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-test-'));
}

test('happy path: renders and sends to each contact, writes report', async () => {
  const wa = stubWa();
  const dir = tmpReports();
  const runner = createRunner({ wa, reportsDir: dir });
  const events = [];
  const { summary, results, reportFile } = await runner.start({
    contacts: [
      makeContact(1, { firstName: 'Ada' }, '+14155550134'),
      makeContact(2, { firstName: 'Bo' }, '+14155550135'),
    ],
    template: 'Hi {{firstName}}!',
    delayMinMs: 1,
    delayMaxMs: 2,
    onProgress: (e) => events.push(e),
  });

  assert.equal(summary.sent, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(wa.sent.map((s) => s.text), ['Hi Ada!', 'Hi Bo!']);
  assert.equal(events.filter((e) => e.type === 'progress').length, 2);
  assert.equal(events.at(-1).type, 'done');
  assert.ok(reportFile);
  const report = JSON.parse(fs.readFileSync(path.join(dir, reportFile), 'utf8'));
  assert.equal(report.summary.sent, 2);
  assert.equal(report.results.length, 2);
  assert.equal(results.length, 2);
});

test('failure modes: unknown var, empty var, bad phone, unregistered, send error', async () => {
  const wa = stubWa({ failCheck: ['+14155550199'], failSend: ['+14155550198'] });
  const runner = createRunner({ wa, reportsDir: tmpReports() });
  const { summary, results } = await runner.start({
    contacts: [
      makeContact(1, { firstName: 'Ada' }, '+14155550134'), // ok
      makeContact(2, {}, '+14155550135'), // unknown var
      makeContact(3, { firstName: '' }, '+14155550136'), // empty var
      makeContact(4, { firstName: 'Cy' }, null), // bad phone
      makeContact(5, { firstName: 'Di' }, '+14155550199'), // not registered
      makeContact(6, { firstName: 'Ed' }, '+14155550198'), // send throws
    ],
    template: 'Hi {{firstName}}!',
    delayMinMs: 1,
    delayMaxMs: 2,
    onProgress: () => {},
  });

  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 5);
  assert.match(results[1].error, /Unknown variable/);
  assert.match(results[2].error, /Empty value/);
  assert.match(results[3].error, /Invalid phone/);
  assert.match(results[4].error, /not registered/);
  assert.match(results[5].error, /boom/);
  assert.equal(wa.sent.length, 1);
});

test('report is written incrementally during the run (crash-safe)', async () => {
  const wa = stubWa();
  const dir = tmpReports();
  const runner = createRunner({ wa, reportsDir: dir });
  let midRunReport = null;
  await runner.start({
    contacts: [
      makeContact(1, { n: 'a' }, '+14155550134'),
      makeContact(2, { n: 'b' }, '+14155550135'),
    ],
    template: 'Hi {{n}}',
    delayMinMs: 1,
    delayMaxMs: 2,
    onProgress: (e) => {
      if (e.type === 'progress' && e.index === 0) {
        // After the first contact, the report file must already exist on disk.
        const file = fs.readdirSync(dir).find((f) => f.startsWith('run-'));
        midRunReport = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      }
    },
  });
  assert.ok(midRunReport, 'report file existed mid-run');
  assert.equal(midRunReport.status, 'running');
  assert.equal(midRunReport.results.length, 1);
  assert.equal(midRunReport.summary.finishedAt, null);
  const file = fs.readdirSync(dir).find((f) => f.startsWith('run-'));
  const finalReport = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  assert.equal(finalReport.status, 'complete');
  assert.equal(finalReport.summary.sent, 2);
  assert.ok(finalReport.summary.finishedAt);
});

test('cancel stops sending and marks the rest cancelled', async () => {
  const wa = stubWa();
  const runner = createRunner({ wa, reportsDir: tmpReports() });
  const contacts = Array.from({ length: 5 }, (_, i) => makeContact(i, { n: `p${i}` }, `+1415555010${i}`));
  const events = [];
  const promise = runner.start({
    contacts,
    template: 'Hi {{n}}',
    delayMinMs: 30,
    delayMaxMs: 40,
    onProgress: (e) => {
      events.push(e);
      if (e.type === 'progress' && e.index === 1) runner.cancel();
    },
  });
  const { summary } = await promise;
  assert.equal(summary.sent, 2);
  assert.equal(summary.cancelled, 3);
  assert.equal(runner.isRunning(), false);
});

test('rejects a second concurrent run', async () => {
  const wa = stubWa();
  const runner = createRunner({ wa, reportsDir: tmpReports() });
  const p = runner.start({
    contacts: [makeContact(1, { n: 'a' }, '+14155550134'), makeContact(2, { n: 'b' }, '+14155550135')],
    template: '{{n}}',
    delayMinMs: 20,
    delayMaxMs: 30,
    onProgress: () => {},
  });
  await assert.rejects(
    () => runner.start({ contacts: [makeContact(3, { n: 'c' }, '+14155550136')], template: '{{n}}' }),
    /already in progress/
  );
  await p;
});

test('validates inputs', async () => {
  const runner = createRunner({ wa: stubWa(), reportsDir: tmpReports() });
  await assert.rejects(() => runner.start({ contacts: [], template: 'x' }), /No contacts/);
  await assert.rejects(() => runner.start({ contacts: [makeContact(1, {}, '+14155550134')], template: '  ' }), /empty/);
});
