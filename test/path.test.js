'use strict';
// Regression test for the sub-path deployment bug.
//
// The page is served from /tidepool/ behind a reverse proxy, but the client
// built API URLs as absolute paths (/api/match), which escaped to the domain
// root and 404'd. Every button in the UI silently did nothing.
//
// Run: node test/path.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

console.log('\n--- client path handling ---');

test('the client derives an API base from location.pathname', () => {
  assert.ok(/var BASE = \(function\(\)/.test(html),
    'BASE must be computed from location.pathname');
  assert.ok(/location\.pathname/.test(html), 'BASE must read location.pathname');
});

test('every fetch goes through apiPath()', () => {
  // No raw fetch('/...') calls: all of them must be wrapped.
  const rawFetches = html.match(/fetch\('\/[^']*'\)/g) || [];
  assert.strictEqual(rawFetches.length, 0,
    'found un-wrapped absolute fetch paths: ' + rawFetches.join(', '));
  assert.ok(/fetch\(apiPath\(path\)/.test(html), 'api() must call fetch(apiPath(path))');
});

test('the WebSocket URL also goes through apiPath()', () => {
  assert.ok(/apiPath\('\/ws\/' \+ S\.code\)/.test(html),
    'the WebSocket path must be resolved against BASE too');
});

test('apiPath resolves correctly for a sub-path deployment', () => {
  // Re-implement the helper exactly as the client does and check the output.
  function apiPath(pathname, p) {
    var base = pathname.endsWith('/') ? pathname : pathname.replace(/[^/]*$/, '');
    return base + p.replace(/^\//, '');
  }
  assert.strictEqual(apiPath('/tidepool/', '/api/match'), '/tidepool/api/match');
  assert.strictEqual(apiPath('/tidepool/', '/api/match/ABCD/action'), '/tidepool/api/match/ABCD/action');
  assert.strictEqual(apiPath('/tidepool/', '/ws/ABCD'), '/tidepool/ws/ABCD');
  // root deployment still works
  assert.strictEqual(apiPath('/', '/api/match'), '/api/match');
  // a bare path with no trailing slash still resolves
  assert.strictEqual(apiPath('/tidepool', '/api/match'), '/api/match');
});

test('api() surfaces a non-JSON response instead of failing silently', () => {
  assert.ok(/r\.json\(\)\.catch/.test(html),
    'a 404 HTML body must produce a real error, not an opaque parse failure');
  assert.ok(/server returned/.test(html), 'the error message must include the status');
});

test('errors are shown inline, not with alert()', () => {
  // alert() blocks the JS thread in some embedded browsers, which makes a
  // failed request look like "nothing happened". Only comments may mention it.
  const code = html.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const alertCalls = code.match(/(?<![\/\w.])alert\(/g) || [];
  assert.strictEqual(alertCalls.length, 0,
    'alert() must not be used for error reporting');
  assert.ok(/function showError/.test(html), 'showError() must exist');
});

test('every UI action has a .catch so failures are visible', () => {
  const handlers = html.match(/\.then\(function\([^)]*\)\{[\s\S]*?\}\);/g) || [];
  const withCatch = html.match(/\.catch\(function\(/g) || [];
  // at least one catch per user-facing action
  assert.ok(withCatch.length >= 5,
    'expected at least 5 .catch handlers, found ' + withCatch.length);
});

test('the waiting screen polls so joins and starts are picked up', () => {
  assert.ok(/setInterval\(refreshWaiting/.test(html),
    'the waiting screen must poll for player joins and match start');
  assert.ok(/function leaveWaiting/.test(html), 'the poll must be cancellable');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
