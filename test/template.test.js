'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { extractVars, render } = require('../src/template');

test('extractVars finds unique variables in order', () => {
  assert.deepEqual(extractVars('Hi {{firstName}} {{lastName}}, bye {{firstName}}'), ['firstName', 'lastName']);
  assert.deepEqual(extractVars('No vars here'), []);
  assert.deepEqual(extractVars('{{ spaced }}'), ['spaced']);
});

test('render substitutes values', () => {
  const row = { firstName: 'Ada', lastName: 'Lovelace' };
  const r = render('Hi {{firstName}} {{lastName}}!', row);
  assert.equal(r.text, 'Hi Ada Lovelace!');
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.empty, []);
});

test('render matches headers case-insensitively and trims', () => {
  const row = { 'First Name': 'Ada' };
  assert.equal(render('Hi {{first name}}!', row).text, 'Hi Ada!');
  assert.equal(render('Hi {{ FIRST NAME }}!', row).text, 'Hi Ada!');
});

test('render reports unknown variables', () => {
  const r = render('Hi {{nickname}}', { firstName: 'Ada' });
  assert.deepEqual(r.unknown, ['nickname']);
  assert.equal(r.text, 'Hi ');
});

test('render reports empty values', () => {
  const r = render('Hi {{nickname}}', { nickname: '  ' });
  assert.deepEqual(r.empty, ['nickname']);
});

test('render leaves non-variable braces alone', () => {
  assert.equal(render('a {not a var} b', {}).text, 'a {not a var} b');
});

test('multiline template', () => {
  const r = render('Hi {{a}},\n\nSee you at {{b}}.', { a: 'Bo', b: 'noon' });
  assert.equal(r.text, 'Hi Bo,\n\nSee you at noon.');
});
