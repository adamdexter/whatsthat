'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildHistory, createHistory } = require('../src/history');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-history-'));
const report = (dir, name, startedAt, results) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ status: 'complete', summary: { startedAt }, template: 'x', results }));

test('buildHistory keeps the latest successful send per phone and counts them', () => {
  const dir = tmp();
  report(dir, 'run-2026-08-01T10-00-00-000Z.json', '2026-08-01T10:00:00.000Z', [
    { phone: '+14155550134', status: 'sent', text: 'first hello' },
    { phone: '+14155550135', status: 'failed', error: 'nope' },
  ]);
  report(dir, 'run-2026-08-20T10-00-00-000Z.json', '2026-08-20T10:00:00.000Z', [
    { phone: '+14155550134', status: 'sent', text: 'second hello' },
    { phone: '+14155550135', status: 'sent', text: 'finally' },
    { phone: '+14155550136', status: 'cancelled' },
  ]);
  fs.writeFileSync(path.join(dir, 'run-2026-08-21T10-00-00-000Z.json'), '{ not json'); // being written / corrupt
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const h = buildHistory(dir);
  assert.equal(h.reports, 3);
  assert.deepEqual(h.byPhone['+14155550134'], { at: '2026-08-20T10:00:00.000Z', text: 'second hello', reportFile: 'run-2026-08-20T10-00-00-000Z.json', count: 2 });
  assert.equal(h.byPhone['+14155550135'].count, 1);
  assert.equal(h.byPhone['+14155550135'].text, 'finally');
  assert.equal(h.byPhone['+14155550136'], undefined, 'cancelled/failed never count');
});

test('buildHistory is empty (not an error) without a reports dir', () => {
  assert.deepEqual(buildHistory(path.join(tmp(), 'missing')), { byPhone: {}, reports: 0 });
});

test('createHistory caches until the reports directory changes', () => {
  const dir = tmp();
  const hist = createHistory(dir);
  assert.deepEqual(hist.get().byPhone, {});
  report(dir, 'run-2026-08-01T10-00-00-000Z.json', '2026-08-01T10:00:00.000Z', [{ phone: '+1555', status: 'sent', text: 'a' }]);
  assert.equal(hist.get().byPhone['+1555'].text, 'a');
  const first = hist.get();
  assert.strictEqual(hist.get(), first, 'same object while nothing changed');
  report(dir, 'run-2026-08-02T10-00-00-000Z.json', '2026-08-02T10:00:00.000Z', [{ phone: '+1555', status: 'sent', text: 'b' }]);
  assert.equal(hist.get().byPhone['+1555'].text, 'b');
  assert.equal(hist.get().byPhone['+1555'].count, 2);
});
