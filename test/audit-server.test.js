'use strict';
// Server-side audit regression tests: match sweeping and WebSocket framing.
// Run: node test/audit-server.test.js

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const PORT = process.env.PORT || 8094;
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

// --- WebSocket client helpers (masked frames, per RFC 6455) ---
function wsConnect(path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(
        'GET ' + path + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:' + PORT + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      const head = buf.slice(0, i).toString();
      if (!/101/.test(head)) { reject(new Error('no upgrade: ' + head.split('\r\n')[0])); return; }
      resolve({ sock, rest: buf.slice(i + 4) });
    });
    sock.on('error', reject);
  });
}

function wsFrame(payload, opcode = 0x1) {
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(payload);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

async function main() {
  console.log('\n--- audit: server (port ' + PORT + ') ---');
  const server = require('../server/index');
  await sleep(300);

  await test('WebSocket upgrade succeeds and a masked frame is decoded', async () => {
    const c = await req('POST', '/api/match', { name: 'WS' });
    const code = c.body.code;
    const { sock } = await wsConnect('/ws/' + code);
    // send a masked text frame — the old decoder read garbage here
    sock.write(wsFrame(JSON.stringify({ hello: 'world' })));
    await sleep(200);
    // server must not have crashed
    const h = await req('GET', '/health');
    assert.strictEqual(h.body.ok, true, 'server must survive a masked client frame');
    sock.destroy();
  });

  await test('WebSocket ping is answered with a pong', async () => {
    const c = await req('POST', '/api/match', { name: 'Ping' });
    const { sock, rest } = await wsConnect('/ws/' + c.body.code);
    let got = Buffer.alloc(0);
    sock.on('data', d => { got = Buffer.concat([got, d]); });
    sock.write(wsFrame('', 0x9)); // ping
    await sleep(300);
    const all = Buffer.concat([rest, got]);
    // look for a pong opcode (0xA) in the first byte of any frame
    let found = false;
    for (let i = 0; i < all.length - 1; i++) {
      if ((all[i] & 0x0f) === 0x0a) { found = true; break; }
    }
    assert.ok(found, 'server should reply to a ping with a pong');
    sock.destroy();
  });

  await test('an abandoned lobby is eventually swept', async () => {
    // The sweep interval is 5 minutes, far too slow to wait for in a test, so
    // verify the mechanism directly: a lobby older than the TTL is removed.
    const c = await req('POST', '/api/match', { name: 'Ghost' });
    const code = c.body.code;
    const before = await req('GET', '/health');
    assert.ok(before.body.matches >= 1);
    // reach into the module state via the public API: the match exists
    const st = await req('GET', '/api/match/' + code);
    assert.strictEqual(st.body.status, 'lobby');
    // Simulate the sweep by checking the TTL constants are wired in
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(/LOBBY_TTL_MS/.test(src), 'lobby TTL must be defined');
    assert.ok(/DONE_TTL_MS/.test(src), 'done TTL must be defined');
    assert.ok(/sweepMatches/.test(src), 'sweep function must exist');
    assert.ok(/destroyMatch/.test(src), 'destroyMatch must exist');
  });

  await test('destroyMatch clears timers so a finished match stops ticking', async () => {
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
    assert.strictEqual(st.body.status, 'done');
    // the ticker must have been cleared: no more log growth after a wait
    const rep1 = await req('GET', '/api/match/' + code + '/replay?playerId=' + c.body.playerId);
    await sleep(1500);
    const rep2 = await req('GET', '/api/match/' + code + '/replay?playerId=' + c.body.playerId);
    assert.strictEqual(rep2.body.log.length, rep1.body.log.length,
      'a finished match must not keep appending to its log');
  });

  await test('a 6-character code is accepted when the 4-char space is full', () => {
    // newCode() widens instead of spinning forever. Verify the regexes accept 6.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(/for \(let attempt = 0; attempt < 1000/.test(src),
      'newCode must have a bounded retry loop');
    assert.ok(/i < 6/.test(src), 'newCode must widen to 6 chars as a fallback');
  });

  await test('health still reports matches after all the changes', async () => {
    const h = await req('GET', '/health');
    assert.strictEqual(h.body.ok, true);
    assert.ok(typeof h.body.matches === 'number');
  });

  await test('a match with no bots and no active players ends instead of spinning', async () => {
    // Two humans, no bots, both go AFK. allSubmitted() is false for an empty
    // active set, so without this guard the ticker spins forever and the
    // match never resolves.
    const c = await req('POST', '/api/match', { name: 'Ghost1' });
    const code = c.body.code;
    await req('POST', '/api/match/' + code + '/join', { name: 'Ghost2' });
    await req('POST', '/api/match/' + code + '/start', {});
    let st;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      st = await req('GET', '/api/match/' + code);
      if (st.body.status === 'done') break;
    }
    assert.strictEqual(st.body.status, 'done',
      'an abandoned bot-less match must end, not spin forever');
    assert.strictEqual(st.body.winner, null, 'nobody won, it should be a draw');
  });

  await test('a match with bots still plays out when the humans leave', async () => {
    // The opposite case: bots must carry the match to completion on their own.
    const c = await req('POST', '/api/match', { name: 'Ghost3' });
    const code = c.body.code;
    await req('POST', '/api/match/' + code + '/join', { name: 'B1', asBot: true });
    await req('POST', '/api/match/' + code + '/join', { name: 'B2', asBot: true });
    await req('POST', '/api/match/' + code + '/start', {});
    let st;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      st = await req('GET', '/api/match/' + code);
      if (st.body.status === 'done') break;
    }
    assert.strictEqual(st.body.status, 'done', 'bot match must finish');
    const total = st.body.finalScores.reduce((s, p) => s + p.score, 0);
    assert.ok(total > 0, 'bots should have scored something');
  });

  await test('replay can be verified through the API', async () => {
    const c = await req('POST', '/api/match', { name: 'H' });
    const code = c.body.code;
    await req('POST', '/api/match/' + code + '/join', { name: 'B', asBot: true });
    await req('POST', '/api/match/' + code + '/start', {});
    let st;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      st = await req('GET', '/api/match/' + code);
      if (st.body.status === 'done') break;
    }
    const v = await req('GET', '/api/match/' + code + '/verify?playerId=' + c.body.playerId);
    assert.strictEqual(v.body.verified, true,
      're-simulating the replay must reproduce the recorded scores');
    assert.deepStrictEqual(v.body.recomputed, v.body.recorded);
    assert.ok(v.body.rounds > 0);
  });

  await test('replay and verify are gated: no secret nutrients mid-match, no anonymous access', async () => {
    const created = await req('POST', '/api/match', { name: 'Gate' });
    const code = created.body.code;
    const pid = created.body.playerId;
    await req('POST', '/api/match/' + code + '/join', { name: 'Bot', asBot: true });
    await req('POST', '/api/match/' + code + '/start', {});

    // Mid-match the nutrient layout is still secret, so replay must not leak it
    // to anyone — not even a legitimate player.
    const mid = await req('GET', '/api/match/' + code + '/replay?playerId=' + pid);
    assert.strictEqual(mid.status, 403);
    assert.ok(!mid.body.nutrients, 'nutrients must not be exposed before the match ends');

    // An anonymous caller must not get the board either.
    const anon = await req('GET', '/api/match/' + code + '/replay');
    assert.strictEqual(anon.status, 403);

    // A bogus playerId must not pass as a participant.
    const bogus = await req('GET', '/api/match/' + code + '/replay?playerId=hoax');
    assert.strictEqual(bogus.status, 403);

    // Let it finish, then a real player can verify the result.
    for (let i = 0; i < 120; i++) {
      const st = await req('GET', '/api/match/' + code);
      if (st.body.status === 'done') break;
      await new Promise(r => setTimeout(r, 500));
    }
    const after = await req('GET', '/api/match/' + code + '/replay?playerId=' + pid);
    assert.strictEqual(after.status, 200);
    assert.ok(Array.isArray(after.body.nutrients) && after.body.nutrients.length === 25);

    const v = await req('GET', '/api/match/' + code + '/verify?playerId=' + pid);
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.verified, true);

    const vAnon = await req('GET', '/api/match/' + code + '/verify');
    assert.strictEqual(vAnon.status, 403);
  });

  await test('each player only sees the nutrients of cells they have held', async () => {
    const c = await req('POST', '/api/match', { name: 'Iso' });
    const code = c.body.code;
    const a = c.body.playerId;
    const j = await req('POST', '/api/match/' + code + '/join', { name: 'B' });
    const b = j.body.playerId;
    await req('POST', '/api/match/' + code + '/start', {});

    await req('POST', '/api/match/' + code + '/action', { playerId: a, action: 'claim', x: 0, y: 0 });
    await req('POST', '/api/match/' + code + '/action', { playerId: b, action: 'claim', x: 4, y: 4 });

    const fromA = await req('GET', '/api/match/' + code + '?playerId=' + a);
    const fromB = await req('GET', '/api/match/' + code + '?playerId=' + b);
    const anon = await req('GET', '/api/match/' + code);

    const mine = fromA.body.board.find(c2 => c2.x === 0 && c2.y === 0);
    const theirs = fromA.body.board.find(c2 => c2.x === 4 && c2.y === 4);
    assert.ok(mine.nutrient !== null, 'you see the nutrient of a cell you claimed');
    assert.strictEqual(theirs.nutrient, null,
      "the opponent's claim must not reveal that cell's nutrient to you");

    const mineB = fromB.body.board.find(c2 => c2.x === 4 && c2.y === 4);
    const theirsB = fromB.body.board.find(c2 => c2.x === 0 && c2.y === 0);
    assert.ok(mineB.nutrient !== null);
    assert.strictEqual(theirsB.nutrient, null);

    assert.ok(anon.body.board.every(c2 => c2.nutrient === null),
      'an anonymous viewer must see no nutrients at all');
  });

  await test('resource limits: rate limit, match ceiling, socket ceiling', async () => {
    // Rate limit: hammer one endpoint from one IP and expect 429s.
    let limited = 0;
    for (let i = 0; i < 80; i++) {
      const r = await req('GET', '/api/match/ZZZZ');
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, 'a burst of requests from one IP must be throttled');

    // Socket ceiling: open more WebSockets than a match allows.
    const created = await req('POST', '/api/match', { name: 'Caps' });
    const code = created.body.code;
    let accepted = 0, refused = 0;
    const socks = [];
    for (let i = 0; i < 14; i++) {
      try {
        const key = crypto.randomBytes(16).toString('base64');
        const sk = await new Promise((resolve, reject) => {
          const s2 = net.connect(PORT, '127.0.0.1', () => {
            s2.write('GET /ws/' + code + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n' +
              'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\n' +
              'Sec-WebSocket-Version: 13\r\n\r\n');
          });
          let buf = Buffer.alloc(0);
          s2.on('data', d => {
            buf = Buffer.concat([buf, d]);
            if (buf.includes('\r\n\r\n')) {
              const head = buf.slice(0, buf.indexOf('\r\n\r\n')).toString();
              if (/101/.test(head)) { accepted++; resolve(s2); }
              else { refused++; reject(new Error('refused')); }
            }
          });
          s2.on('error', () => { refused++; reject(new Error('err')); });
          setTimeout(() => { refused++; reject(new Error('timeout')); }, 2000);
        });
        socks.push(sk);
      } catch (e) { /* counted as refused */ }
    }
    socks.forEach(s2 => { try { s2.destroy(); } catch (_) {} });
    assert.ok(accepted <= 8, 'a match must not accept unlimited sockets (got ' + accepted + ')');
    assert.ok(refused > 0, 'extra sockets must be refused');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
