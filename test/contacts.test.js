'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildContacts, displayName } = require('../src/contacts');

const VALUES = [
  ['firstName', 'lastName', 'nickname', 'phone'],
  ['Ada', 'Lovelace', 'Ada', '415-555-0134'],
  ['Alan', 'Turing', '', 'not-a-phone'],
];

test('builds contacts with normalized phones', () => {
  const { headers, contacts, error } = buildContacts(VALUES);
  assert.equal(error, null);
  assert.deepEqual(headers, ['firstName', 'lastName', 'nickname', 'phone']);
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].phone, '+14155550134');
  assert.equal(contacts[0].fields.firstName, 'Ada');
  assert.equal(contacts[1].phone, null);
  assert.ok(contacts[1].phoneError);
});

test('requires a phone column', () => {
  const { error } = buildContacts([['name'], ['Ada']]);
  assert.match(error, /phone/i);
});

test('phone column match is case-insensitive', () => {
  const { contacts, error } = buildContacts([
    ['Name', 'Phone'],
    ['Ada', '4155550134'],
  ]);
  assert.equal(error, null);
  assert.equal(contacts[0].phone, '+14155550134');
});

test('short rows are padded with empty fields', () => {
  const { contacts } = buildContacts([
    ['firstName', 'nickname', 'phone'],
    ['Ada'], // Sheets omits trailing empty cells
  ]);
  assert.equal(contacts[0].fields.nickname, '');
  assert.equal(contacts[0].phone, null);
});

test('empty sheet and header-only sheet are errors', () => {
  assert.ok(buildContacts([]).error);
  assert.ok(buildContacts([['firstName', 'phone']]).error);
});

test('displayName prefers first+last, falls back to phone', () => {
  const { contacts } = buildContacts(VALUES);
  assert.equal(displayName(contacts[0]), 'Ada Lovelace');
  const { contacts: c2 } = buildContacts([
    ['x', 'phone'],
    ['?', '4155550134'],
  ]);
  assert.equal(displayName(c2[0]), '+14155550134');
});
