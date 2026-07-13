'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizePhone } = require('../src/phone');

test('US 10-digit numbers get +1', () => {
  assert.equal(normalizePhone('4155550134').e164, '+14155550134');
  assert.equal(normalizePhone('415-555-0134').e164, '+14155550134');
  assert.equal(normalizePhone('(415) 555-0134').e164, '+14155550134');
  assert.equal(normalizePhone(' 415.555.0134 ').e164, '+14155550134');
});

test('US 11-digit with leading 1', () => {
  assert.equal(normalizePhone('14155550134').e164, '+14155550134');
  assert.equal(normalizePhone('1-415-555-0134').e164, '+14155550134');
});

test('international numbers with + pass through', () => {
  assert.equal(normalizePhone('+447911123456').e164, '+447911123456');
  assert.equal(normalizePhone('+44 7911 123456').e164, '+447911123456');
  assert.equal(normalizePhone('+1 (415) 555-0134').e164, '+14155550134');
});

test('invalid numbers are rejected with a reason', () => {
  assert.equal(normalizePhone('555-0134').e164, null);
  assert.match(normalizePhone('555-0134').error, /10-digit/);
  assert.equal(normalizePhone('').e164, null);
  assert.equal(normalizePhone('   ').e164, null);
  assert.equal(normalizePhone(null).e164, null);
  assert.equal(normalizePhone('n/a').e164, null);
  assert.equal(normalizePhone('+123').e164, null); // too short for international
  assert.equal(normalizePhone('123456789012').e164, null); // 12 digits, no +
});

test('numeric input (as from a spreadsheet cell) works', () => {
  assert.equal(normalizePhone(4155550134).e164, '+14155550134');
});
