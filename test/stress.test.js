'use strict';
// Stress / edge-case tests for things the main suites do not cover:
// stalled rounds, disconnects, bad input, double submits, replay integrity.
// Run: node test/stress.test.js

const assert = require('assert');
const http = require('http');

const PORT = process.env.PORT || 8095;
process.env.PORT = String(PORT);

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok  ' + name); })
    .catch(e => { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); });
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\n--- stress (port ' + PORT + ') ---');
  const server = require('../server/index');
  await sleep(300);

  await test('double submit in the same round is rejected', async () => {
    // Use a match with no bots so the round cannot resolve underneath us.
    const c = await req('POST', '/api/match', { name: 'H' });
    const code = c.body.code, pid = c.body.playerId;
    const j = await req('POST', '/api/match/' + code + '/join', { name: 'Rival' });
    await req('POST', '/api/match/' + code + '/start', {});
    const a1 = await req('POST', '/api/match/' + code + '/action',
      { playerId: pid, action: 'claim', x: 1, y: 1 });
    assert.strictEqual(a1.body.ok, true);
    const a2 = await req('POST', '/api/match/' + code + '/action',
      { playerId: pid, action: 'claim', x: 2, y: 2 });
    assert.strictEqual(a2.body.ok, false, 'second submit in the same round must be rejected');
    // the rival has not acted yet, so the round is still open
    const st = await req('GET', '/api/match/' + code);
    assert.strictEqual(st.body.round, 1);
    const mine = st.body.board.filter(c => c.owner === pid);
    assert.strictEqual(mine.length, 0, 'nothing resolves until the rival acts');
  });

  await test('a new round accepts a fresh action after the previous one resolved', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    const code = c.body.code, pid = c.body.playerId;
    const j = await req('POST', '/api/match/' + code + '/join', { name: 'Rival' });
    await req('POST', '/api/match/' + code + '/start', {});
    await req('POST', '/api/match/' + code + '/action',
      { playerId: pid, action: 'claim', x: 1, y: 1 });
    await req('POST', '/api/match/' + code + '/action',
      { playerId: j.body.playerId, action: 'claim', x: 3, y: 3 });
    await sleep(300);
    const st = await req('GET', '/api/match/' + code);
    assert.strictEqual(st.body.round, 2, 'round should have advanced');
    // now a new action is accepted
    const r = await req('POST', '/api/match/' + code + '/action',
      { playerId: pid, action: 'claim', x: 2, y: 2 });
    assert.strictEqual(r.body.ok, true, 'a new round must accept a new action');
  });

  await test('unknown playerId is rejected', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    const r = await req('POST', '/api/match/' + c.body.code + '/action',
      { playerId: 'p_nope', action: 'claim', x: 0, y: 0 });
    assert.strictEqual(r.body.ok, false);
  });

  await test('malformed body does not crash the server', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    // send raw garbage
    const r = await new Promise((resolve, reject) => {
      const rq = http.request({
        host: '127.0.0.1', port: PORT, path: '/api/match/' + c.body.code + '/action',
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      }, res => {
        let d = '';
        res.on('data', x => d += x);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      rq.on('error', reject);
      rq.write('{{{not json');
      rq.end();
    });
    assert.ok(r.status >= 400, 'garbage body should be a 4xx, got ' + r.status);
    const h = await req('GET', '/health');
    assert.strictEqual(h.body.ok, true, 'server must still be alive');
  });

  await test('feed on an enemy cell is rejected', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    const code = c.body.code;
    const j = await req('POST', '/api/match/' + code + '/join', { name: 'R' });
    await req('POST', '/api/match/' + code + '/start', {});
    await req('POST', '/api/match/' + code + '/action',
      { playerId: c.body.playerId, action: 'claim', x: 0, y: 0 });
    await req('POST', '/api/match/' + code + '/action',
      { playerId: j.body.playerId, action: 'claim', x: 4, y: 4 });
    await sleep(300);
    const st = await req('GET', '/api/match/' + code);
    const enemy = st.body.board.find(c => c.x === 4 && c.y === 4);
    const r = await req('POST', '/api/match/' + code + '/action',
      { playerId: c.body.playerId, action: 'feed', x: 4, y: 4 });
    assert.strictEqual(r.body.ok, false, 'cannot feed an enemy cell');
  });

  await test('a stalled round always resolves (watchdog)', async () => {
    // Create a match, start it, and never submit anything. The AFK timer plus
    // the watchdog must carry the match to completion on its own.
    const c = await req('POST', '/api/match', { name: 'Ghost' });
    const code = c.body.code;
    await req('POST', '/api/match/' + code + '/join', { name: 'B1', asBot: true });
    await req('POST', '/api/match/' + code + '/join', { name: 'B2', asBot: true });
    await req('POST', '/api/match/' + code + '/start', {});
    let st;
    for (let i = 0; i < 160; i++) {
      await sleep(500);
      st = await req('GET', '/api/match/' + code);
      if (st.body.status === 'done') break;
    }
    assert.strictEqual(st.body.status, 'done', 'abandoned match must still finish');
    assert.ok(st.body.finalScores.length >= 2);
  });

  await test('replay round count matches the played round count', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    const code = c.body.code;
    await req('POST', '/api/match/' + code + '/join', { name: 'B', asBot: true });
    await req('POST', '/api/match/' + code + '/start', {});
    let st;
    for (let i = 0; i < 160; i++) {
      await sleep(500);
      st = await req('GET', '/api/match/' + code);
      if (st.body.status === 'done') break;
    }
    const rep = await req('GET', '/api/match/' + code + '/replay?playerId=' + c.body.playerId);
    const rounds = rep.body.log.filter(e => e.events !== undefined).length;
    assert.strictEqual(rounds, st.body.round,
      'replay rounds ' + rounds + ' != played rounds ' + st.body.round);
    // every logged score must be non-negative and the winner must exist
    for (const e of rep.body.log) {
      if (e.scores) for (const s of e.scores) assert.ok(s.score >= 0);
    }
    assert.ok(st.body.winner !== undefined);
  });

  await test('replay nutrients are all in range 1-5', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    await req('POST', '/api/match/' + c.body.code + '/join', { name: 'B', asBot: true });
    await req('POST', '/api/match/' + c.body.code + '/start', {});
    // Replay is gated until the match ends, so play it out first.
    for (let i = 0; i < 160; i++) {
      await sleep(500);
      const st = await req('GET', '/api/match/' + c.body.code);
      if (st.body.status === 'done') break;
    }
    const rep = await req('GET', '/api/match/' + c.body.code + '/replay?playerId=' + c.body.playerId);
    assert.strictEqual(rep.body.nutrients.length, 25);
    for (const n of rep.body.nutrients) {
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 5, 'bad nutrient ' + n);
    }
  });

  await test('many concurrent matches do not interfere', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const c = await req('POST', '/api/match', { name: 'M' + i });
      codes.push(c.body.code);
      await req('POST', '/api/match/' + c.body.code + '/join', { name: 'B', asBot: true });
    }
    for (const code of codes) await req('POST', '/api/match/' + code + '/start', {});
    await sleep(1200);
    for (const code of codes) {
      const st = await req('GET', '/api/match/' + code);
      assert.strictEqual(st.body.status, 'playing', code + ' should be playing');
      assert.strictEqual(st.body.board.length, 25);
    }
    const h = await req('GET', '/health');
    assert.ok(h.body.matches >= 6, 'health should count all matches');
  });

  await test('starting twice is rejected', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    await req('POST', '/api/match/' + c.body.code + '/join', { name: 'B', asBot: true });
    const r1 = await req('POST', '/api/match/' + c.body.code + '/start', {});
    assert.strictEqual(r1.status, 200);
    const r2 = await req('POST', '/api/match/' + c.body.code + '/start', {});
    assert.strictEqual(r2.status, 409, 'second start must be 409');
  });

  await test('joining a full match is rejected', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    for (let i = 0; i < 5; i++) {
      await req('POST', '/api/match/' + c.body.code + '/join', { name: 'P' + i, asBot: i > 0 });
    }
    const st = await req('GET', '/api/match/' + c.body.code);
    assert.ok(st.body.players.length <= 4, 'match must cap at 4 players');
  });

  await test('hidden information is never leaked before claiming', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    const code = c.body.code;
    await req('POST', '/api/match/' + code + '/join', { name: 'B', asBot: true });
    await req('POST', '/api/match/' + code + '/start', {});
    const st = await req('GET', '/api/match/' + code);
    for (const cell of st.body.board) {
      if (cell.owner === null) {
        assert.strictEqual(cell.nutrient, null, 'unowned cell must hide its nutrient');
        assert.strictEqual(cell.score, null, 'unowned cell must hide its score');
      }
    }
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
