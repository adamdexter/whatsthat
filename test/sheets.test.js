'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { extractSpreadsheetId } = require('../src/sheets');

test('extracts id from full URLs', () => {
  assert.equal(
    extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345678901234567890/edit#gid=0'),
    '1AbC_dEf-123456789012345678901234567890'
  );
  assert.equal(
    extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC123/edit'),
    '1AbC123'
  );
});

test('extracts id from multi-account /u/N/ URLs', () => {
  assert.equal(
    extractSpreadsheetId('https://docs.google.com/spreadsheets/u/1/d/1AbC_dEf-123456789012345678901234567890/edit'),
    '1AbC_dEf-123456789012345678901234567890'
  );
});

test('accepts a bare id', () => {
  assert.equal(extractSpreadsheetId('1AbC_dEf-123456789012345678901234567890'), '1AbC_dEf-123456789012345678901234567890');
});

test('rejects junk', () => {
  assert.equal(extractSpreadsheetId('not a sheet'), null);
  assert.equal(extractSpreadsheetId(''), null);
  assert.equal(extractSpreadsheetId(null), null);
  assert.equal(extractSpreadsheetId('https://example.com/foo'), null);
});
