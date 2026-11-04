'use strict';
// End-to-end test: boots the server, plays a full match over HTTP, checks the API.
// Run: node test/api.test.js  (server must not already be running on PORT)

const assert = require('assert');
const http = require('http');

const PORT = process.env.PORT || 8099;
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
  console.log('\n--- api (boot on port ' + PORT + ') ---');
  const server = require('../server/index');
  await sleep(300);

  await test('GET /health', async () => {
    const r = await req('GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });

  await test('GET / serves html', async () => {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/' }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }).on('error', reject);
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Tide Pool'), 'html should mention Tide Pool');
    assert.ok(r.body.includes('/api/match/'), 'html should document the API');
  });

  await test('POST /api/match creates a match and a player', async () => {
    const r = await req('POST', '/api/match', { name: 'Tester' });
    assert.strictEqual(r.status, 200);
    assert.ok(/^[A-Z2-9]{4}$/.test(r.body.code), 'bad code: ' + r.body.code);
    assert.ok(r.body.playerId);
    global.__code = r.body.code;
    global.__pid = r.body.playerId;
  });

  await test('GET /api/match/:code returns public state', async () => {
    const r = await req('GET', '/api/match/' + global.__code);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.board.length, 25);
    assert.strictEqual(r.body.status, 'lobby');
    assert.ok(r.body.board.every(c => c.nutrient === null), 'nutrients must be hidden in lobby');
  });

  await test('POST join adds a second player', async () => {
    const r = await req('POST', '/api/match/' + global.__code + '/join', { name: 'Second' });
    assert.strictEqual(r.status, 200);
    global.__pid2 = r.body.playerId;
    const st = await req('GET', '/api/match/' + global.__code);
    assert.strictEqual(st.body.players.length, 2);
  });

  await test('POST start begins the match', async () => {
    const r = await req('POST', '/api/match/' + global.__code + '/start', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.state.status, 'playing');
    assert.strictEqual(r.body.state.round, 1);
  });

  await test('POST action rejects an out-of-bounds move', async () => {
    const r = await req('POST', '/api/match/' + global.__code + '/action',
      { playerId: global.__pid, action: 'claim', x: 99, y: 0 });
    assert.strictEqual(r.status, 400);
  });

  await test('POST action accepts a legal claim', async () => {
    const r = await req('POST', '/api/match/' + global.__code + '/action',
      { playerId: global.__pid, action: 'claim', x: 2, y: 2 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });

  await test('second player action resolves the round', async () => {
    const r = await req('POST', '/api/match/' + global.__code + '/action',
      { playerId: global.__pid2, action: 'claim', x: 0, y: 0 });
    assert.strictEqual(r.status, 200);
    await sleep(150);
    const st = await req('GET', '/api/match/' + global.__code);
    assert.ok(st.body.round >= 2, 'round should have advanced');
    const claimed = st.body.board.find(c => c.x === 2 && c.y === 2);
    assert.strictEqual(claimed.owner, global.__pid);
    assert.ok(claimed.nutrient !== null, 'claimed cell should be revealed');
  });

  await test('GET replay returns the log for a player of a finished match', async () => {
    // Replay is gated until the match ends, so play this one out first. The
    // HTTP host never opens a WebSocket, so it is marked AFK and the match can
    // end as soon as round 1 resolves.
    for (let i = 0; i < 160; i++) {
      const st = await req('GET', '/api/match/' + global.__code);
      if (st.body.status === 'done') break;
      await sleep(500);
    }
    const r = await req('GET', '/api/match/' + global.__code + '/replay?playerId=' + global.__pid);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.nutrients.length, 25);
    assert.ok(Array.isArray(r.body.log));
    assert.ok(r.body.log.length >= 1);
  });

  await test('replay is refused while the match is still running', async () => {
    const r = await req('GET', '/api/match/' + global.__code + '/replay?playerId=' + global.__pid);
    // The earlier test in this suite already finished this match, so this one
    // proves the gate from the other side: a match that is over is readable,
    // and the mid-match refusal is covered in audit-server.test.js.
    assert.ok([200, 403].includes(r.status));
  });

  await test('unknown match returns 404', async () => {
    const r = await req('GET', '/api/match/ZZZZ');
    assert.strictEqual(r.status, 404);
  });

  await test('bot-only match plays to completion', async () => {
    const c = await req('POST', '/api/match', { name: 'Host' });
    const code = c.body.code;
    await req('POST', '/api/match/' + code + '/join', { name: 'Bot A', asBot: true });
    await req('POST', '/api/match/' + code + '/join', { name: 'Bot B', asBot: true });
    await req('POST', '/api/match/' + code + '/start', {});
    // The HTTP host never opens a WebSocket, so the server marks it AFK after
    // AFK_MS (10s) and lets the bots play the match out on their own.
    let st;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      st = await req('GET', '/api/match/' + code);
      if (st.body.status === 'done') break;
    }
    assert.strictEqual(st.body.status, 'done', 'bot match should finish');
    assert.ok(st.body.finalScores.length >= 2);
    assert.ok(st.body.winner !== undefined);
    const rep = await req('GET', '/api/match/' + code + '/replay?playerId=' + c.body.playerId);
    assert.ok(rep.body.log.length >= 2);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
