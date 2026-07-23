'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { waFormatToHtml: f } = require('../public/format');

test('plain text passes through', () => {
  assert.equal(f('hello there'), 'hello there');
});

test('bold, italic, strikethrough', () => {
  assert.equal(f('this is *not* fine'), 'this is <b>not</b> fine');
  assert.equal(f('_gentle_ nudge'), '<i>gentle</i> nudge');
  assert.equal(f('~old~ new'), '<s>old</s> new');
});

test('markers with inner whitespace stay literal (WhatsApp behavior)', () => {
  assert.equal(f('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(f('* leading and trailing *'), '* leading and trailing *');
});

test('unmatched markers stay literal', () => {
  assert.equal(f('single *star'), 'single *star');
  assert.equal(f('a_b'), 'a_b'); // no closing marker
});

test('formatting does not span line breaks', () => {
  assert.equal(f('*line one\nline two*'), '*line one\nline two*');
});

test('nested bold+italic', () => {
  assert.equal(f('*_both_*'), '<b><i>both</i></b>');
});

test('inline code is literal inside', () => {
  assert.equal(f('run `npm *start*` now'), 'run <code>npm *start*</code> now');
});

test('triple-backtick block spans lines and stays literal inside', () => {
  assert.equal(f('```a *b*\nc _d_```'), '<code>a *b*\nc _d_</code>');
});

test('HTML in text or contact data is escaped', () => {
  assert.equal(f('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(f('*<b>*'), '<b>&lt;b&gt;</b>');
});

test('digits between NUL bytes cannot forge stash lookups', () => {
  const NUL = String.fromCharCode(0);
  assert.equal(f(`a${NUL}0${NUL}b and \`x\``), 'a0b and <code>x</code>');
});
