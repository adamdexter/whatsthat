'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseCsv } = require('../src/csv');

test('basic CSV', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('quoted fields with commas and escaped quotes', () => {
  assert.deepEqual(parseCsv('name,quote\n"Lovelace, Ada","She said ""hi"""'), [
    ['name', 'quote'],
    ['Lovelace, Ada', 'She said "hi"'],
  ]);
});

test('CRLF and trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('blank lines are dropped', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n,\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('newline inside quoted field', () => {
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",x'), [
    ['a', 'b'],
    ['line1\nline2', 'x'],
  ]);
});

test('TSV (cells pasted from Google Sheets/Excel) is auto-detected', () => {
  assert.deepEqual(parseCsv('firstName\tphone\nAda\t415-555-0134'), [
    ['firstName', 'phone'],
    ['Ada', '415-555-0134'],
  ]);
});

test('TSV values containing commas stay in one field', () => {
  assert.deepEqual(parseCsv('name\tnote\nAda\tHi, there'), [
    ['name', 'note'],
    ['Ada', 'Hi, there'],
  ]);
});
