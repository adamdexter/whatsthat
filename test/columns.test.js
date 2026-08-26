'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyColumns } = require('../public/columns');

// n contacts; `col` gets value i % k (k distinct values), plus optional extra columns.
function contacts(n, spec) {
  return Array.from({ length: n }, (_, i) => {
    const fields = { firstName: `Person${i}`, phone: `+1415555${String(i).padStart(4, '0')}` };
    for (const [h, fn] of Object.entries(spec)) fields[h] = fn(i);
    return { id: i, fields, phone: fields.phone };
  });
}
const kinds = (cols) => Object.fromEntries(cols.map((c) => [c.header, c.kind]));

test('50 contacts: ≤5 distinct is a filter, 6–13 asks, more is a field; unique columns are fields; phone is skipped', () => {
  const list = contacts(50, { rank: (i) => `R${i % 5}`, city: (i) => `C${i % 9}`, team: (i) => `T${i % 20}`, email: (i) => `p${i}@example.com` });
  const cols = classifyColumns({ headers: ['firstName', 'phone', 'rank', 'city', 'team', 'email'], contacts: list });
  assert.deepEqual(kinds(cols), { firstName: 'field', rank: 'filter', city: 'ask', team: 'field', email: 'field' });
  const rank = cols.find((c) => c.header === 'rank');
  assert.equal(rank.autoMax, 5, '10% of 50');
  assert.equal(rank.askMax, 13, '25% of 50, rounded up');
  assert.deepEqual(rank.values, ['R0', 'R1', 'R2', 'R3', 'R4']);
  assert.equal(cols.find((c) => c.header === 'team').reason, 'too-many');
  assert.equal(cols.find((c) => c.header === 'email').reason, 'unique');
  assert.ok(!cols.some((c) => c.header === 'phone'));
});

test('small lists keep the floors: 14 contacts still auto-filter a 4-value column and ask up to 8', () => {
  const list = contacts(14, { rank: (i) => ['Prospect', 'EA', 'FC', 'MM'][i % 4], city: (i) => `City${i % 6}`, nickname: (i) => `Nick${i}` });
  const cols = classifyColumns({ headers: ['rank', 'city', 'nickname', 'phone'], contacts: list });
  assert.deepEqual(kinds(cols), { rank: 'filter', city: 'ask', nickname: 'field' });
  assert.equal(cols[0].autoMax, 4);
  assert.equal(cols[0].askMax, 8);
});

test('a single repeated value only counts as a filter when blanks give it something to contrast with', () => {
  const allActive = contacts(10, { Status: () => 'Active' });
  assert.equal(classifyColumns({ headers: ['Status'], contacts: allActive })[0].kind, 'field');
  const someBlank = contacts(10, { Status: (i) => (i % 3 ? 'Active' : '') });
  const c = classifyColumns({ headers: ['Status'], contacts: someBlank })[0];
  assert.equal(c.kind, 'filter');
  assert.equal(c.hasBlank, true);
  assert.equal(c.blanks, 4);
});

test('values are merged case-insensitively and an empty column is a field', () => {
  const list = contacts(6, { Status: (i) => ['Active', 'active', 'ACTIVE', 'Inactive', 'inactive', 'Active'][i], notes: () => '' });
  const cols = classifyColumns({ headers: ['Status', 'notes'], contacts: list });
  assert.equal(cols[0].kind, 'filter');
  assert.deepEqual(cols[0].values, ['Active', 'Inactive']);
  assert.equal(cols[1].kind, 'field');
  assert.equal(cols[1].reason, 'empty');
});

test('remembered decisions override the heuristic in both directions (case-insensitive header)', () => {
  const list = contacts(50, { rank: (i) => `R${i % 5}`, city: (i) => `C${i % 9}`, team: (i) => `T${i % 20}` });
  const cols = classifyColumns({ headers: ['rank', 'city', 'team'], contacts: list, decisions: { rank: 'field', city: 'filter', team: 'filter' } });
  assert.deepEqual(kinds(cols), { rank: 'field', city: 'filter', team: 'filter' });
  assert.ok(cols.every((c) => c.reason === 'chosen'));
  const upper = classifyColumns({ headers: ['Rank'], contacts: list, decisions: { rank: 'field' } });
  assert.equal(upper[0].kind, 'field');
});

test('fewer than two contacts never produces filters or questions', () => {
  const cols = classifyColumns({ headers: ['rank'], contacts: contacts(1, { rank: () => 'A' }) });
  assert.equal(cols[0].kind, 'field');
});
