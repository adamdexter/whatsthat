'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyDisconnect } = require('../src/whatsapp');

test('classifyDisconnect: relink for unlinks, fatal for blocks, relaunch for everything else', () => {
  for (const r of ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'logout']) assert.equal(classifyDisconnect(r), 'relink', r);
  for (const r of ['TOS_BLOCK', 'SMB_TOS_BLOCK', 'PROXYBLOCK']) assert.equal(classifyDisconnect(r), 'fatal', r);
  for (const r of ['CONFLICT', 'UNLAUNCHED', 'DEPRECATED_VERSION', 'TIMEOUT', 'NAVIGATION', undefined, null, '']) {
    assert.equal(classifyDisconnect(r), 'relaunch', String(r));
  }
});
