'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installFileLog, rotateIfNeeded } = require('../src/log');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-log-'));

test('installFileLog tees every console level into the file and keeps the original output', () => {
  const dir = tmp();
  const file = path.join(dir, 'logs', 'engine.log');
  const calls = [];
  const fake = { log: (...a) => calls.push(['log', a]), info: () => {}, warn: () => {}, error: (...a) => calls.push(['error', a]) };
  const r = installFileLog({ file, console: fake });
  assert.equal(r.file, file);
  fake.log('hello %s', 'world');
  fake.error('boom', new Error('bad'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\[log\] hello world\n/);
  assert.match(text, /\[error\] boom Error: bad/);
  assert.match(text, /^\[\d{4}-\d{2}-\d{2}T/, 'timestamped');
  assert.equal(calls.length, 2, 'original console still called');
});

test('rotateIfNeeded shifts file → .1 → .2 and drops the oldest', () => {
  const file = path.join(tmp(), 'engine.log');
  fs.writeFileSync(file, 'a'.repeat(50));
  assert.equal(rotateIfNeeded(file, 100, 2), false, 'under the cap');
  fs.writeFileSync(file, 'b'.repeat(150));
  assert.equal(rotateIfNeeded(file, 100, 2), true);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8')[0], 'b');
  fs.writeFileSync(file, 'c'.repeat(150));
  rotateIfNeeded(file, 100, 2);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8')[0], 'c');
  assert.equal(fs.readFileSync(`${file}.2`, 'utf8')[0], 'b');
  fs.writeFileSync(file, 'd'.repeat(150));
  rotateIfNeeded(file, 100, 2);
  assert.equal(fs.readFileSync(`${file}.2`, 'utf8')[0], 'c', 'oldest dropped');
  assert.ok(!fs.existsSync(`${file}.3`));
  assert.equal(rotateIfNeeded(path.join(tmp(), 'missing.log'), 1, 1), false);
});
