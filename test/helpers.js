'use strict';

// Shared bits for the e2e tests. The engine requires an API token on every
// /api route except /api/ping; tests pin it via WHATSTHAT_API_TOKEN.
const TOKEN = 'test-token';
const AUTH = { 'X-WhatsThat-Token': TOKEN };

module.exports = { TOKEN, AUTH };
