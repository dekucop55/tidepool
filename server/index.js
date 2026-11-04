'use strict';
// Tide Pool HTTP + WebSocket server.
// Humans: browser at /. Agents: HTTP/JSON API documented in README.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const engine = require('./engine');
const bot = require('./bot');

const PORT = process.env.PORT || 8091;
const PUBLIC = path.join(__dirname, '..', 'public');

const matches = new Map(); // code -> match
const sockets = new Map(); // code -> Set<ws>

// --- tiny WebSocket implementation (RFC 6455, no deps) ---
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function wsEncode(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsDecode(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x8) return { type: 'close' };
  // Client frames are always masked (RFC 6455 §5.1). Unmask before reading.
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  if (masked) {
    if (buf.length < offset + 4) return null;
    offset += 4; // skip the 4-byte masking key, handled below
  }
  if (buf.length < offset + len) return null; // incomplete frame
  const payload = Buffer.from(buf.slice(offset, offset + len));
  if (masked) {
    const maskKey = buf.slice(offset - 4, offset);
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  // ping (0x9) / pong (0xA) carry no game payload
  if (opcode === 0x9) return { type: 'ping' };
  if (opcode === 0xA) return { type: 'pong' };
  return { type: 'text', data: payload.toString('utf8') };
}

function broadcast(code, obj) {
  const set = sockets.get(code);
  if (!set) return;
  const msg = wsEncode(JSON.stringify(obj));
  for (const ws of set) {
    // A full socket buffer makes write() return false and drop data silently.
    // Pause and resume on drain instead of pretending the send succeeded.
    try {
      if (ws.write(msg) === false && !ws._paused) {
        ws._paused = true;
        ws.once('drain', () => { ws._paused = false; });
      }
    } catch (_) {}
  }
}

// --- helpers ---
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 1000; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    if (!matches.has(c)) return c;
  }
  // Space is exhausted (or astronomically unlucky). Widen rather than spin.
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// --- match lifecycle ---
// Matches are held in memory only. Without an expiry, a match that is created
// but never started (or abandoned mid-game) leaks forever, and its lobby entry
// is never reclaimed. Sweep anything that is done or has sat in the lobby
// untouched for LOBBY_TTL_MS.
const LOBBY_TTL_MS = 60 * 60 * 1000; // 1 hour in the lobby
const DONE_TTL_MS = 30 * 60 * 1000;  // 30 minutes after finishing
const SWEEP_MS = 5 * 60 * 1000;      // check every 5 minutes

function destroyMatch(m) {
  if (!m) return;
  if (m._tick) { clearInterval(m._tick); m._tick = null; }
  if (m._afkTimer) { clearTimeout(m._afkTimer); m._afkTimer = null; }
  matches.delete(m.code);
  sockets.delete(m.code);
}

function sweepMatches() {
  const now = Date.now();
  for (const m of matches.values()) {
    // A match where every human has gone AFK and there are no bots can never
    // resolve: allSubmitted() is false for an empty active set, so the ticker
    // spins forever. End it instead of leaking the timer.
    if (m.status === 'playing' && engine.activePlayers(m).length === 0) {
      const bots = m.players.filter(p => p.isBot);
      if (bots.length === 0) {
        console.log('ending abandoned match ' + m.code + ' (no active players, no bots)');
        m.status = 'done';
        m._finishedAt = now;
        m.finalScores = m.players.map(p => ({ id: p.id, name: p.name, score: p.score, cells: p.cells }));
        m.winner = null;
        m.log.push({ round: m.round, type: 'draw', players: m.players.map(p => p.id) });
        broadcast(m.code, { type: 'end', state: engine.publicState(m) });
        if (m._tick) { clearInterval(m._tick); m._tick = null; }
        continue;
      }
    }
    if (m.status === 'done' && now - (m._finishedAt || now) > DONE_TTL_MS) {
      console.log('sweeping finished match ' + m.code);
      destroyMatch(m);
    } else if (m.status === 'lobby' && now - m._createdAt > LOBBY_TTL_MS) {
      console.log('sweeping abandoned lobby ' + m.code);
      destroyMatch(m);
    }
  }
}
setInterval(sweepMatches, SWEEP_MS).unref();

function fillBots(m) {
  // Fill empty seats with bots after a short delay so humans can join first.
  const need = Math.max(0, 2 - m.players.filter(p => !p.isBot).length);
  for (let i = 0; i < need; i++) {
    if (m.players.length >= 4) break;
    const id = 'bot_' + crypto.randomBytes(4).toString('hex');
    engine.addPlayer(m, { id, name: 'Crab ' + (m.players.length + 1), isBot: true });
  }
}

// A human who created or joined over plain HTTP has no WebSocket, so nothing
// ever marks them away. If they have not acted within AFK_MS of a round
// starting, treat them as disconnected so the match can play itself out.
const AFK_MS = 10000;
function scheduleAfkCheck(m) {
  if (m._afkTimer) clearTimeout(m._afkTimer);
  m._afkTimer = setTimeout(() => {
    if (m.status !== 'playing') return;
    let changed = false;
    for (const p of m.players) {
      if (!p.isBot && p.connected && !m.pending[p.id]) {
        p.connected = false;
        changed = true;
        console.log('player ' + p.id + ' marked AFK in ' + m.code);
      }
    }
    if (changed) {
      broadcast(m.code, { type: 'pending', state: engine.publicState(m) });
      maybeRunBots(m);
    }
  }, AFK_MS);
}

function maybeRunBots(m) {
  if (m.status !== 'playing') return;
  const active = m.players.filter(p => p.connected);
  const humans = active.filter(p => !p.isBot);
  const humansPending = humans.filter(p => m.pending[p.id]).length;
  // Bots act once every ACTIVE human has acted, or when there are no active
  // humans at all (a bot-only or abandoned match must still play itself out).
  if (humans.length > 0 && humansPending < humans.length) return;
  // Nobody is left to play and there are no bots: the round can never resolve,
  // so end the match rather than spinning the ticker forever.
  if (humans.length === 0 && m.players.every(p => !p.isBot)) {
    console.log('ending match ' + m.code + ': no active players and no bots');
    m.status = 'done';
    m._finishedAt = Date.now();
    m.finalScores = m.players.map(p => ({ id: p.id, name: p.name, score: p.score, cells: p.cells }));
    m.winner = null;
    m.log.push({ round: m.round, type: 'draw', players: m.players.map(p => p.id) });
    broadcast(m.code, { type: 'end', state: engine.publicState(m) });
    if (m._tick) { clearInterval(m._tick); m._tick = null; }
    return;
  }
  for (const p of m.players) {
    if (!p.isBot) continue;
    if (m.pending[p.id]) continue;
    const state = engine.publicState(m, p.id);
    let act;
    try {
      act = bot.chooseAction(state, p.id);
    } catch (e) {
      console.error('bot ' + p.id + ' threw: ' + (e && e.message));
      act = { action: 'claim', x: 0, y: 0 };
    }
    engine.submitAction(m, p.id, act);
  }
  if (engine.allSubmitted(m)) {
    const result = engine.resolveRound(m);
    broadcast(m.code, { type: 'round', result, state: engine.publicState(m) });
    if (m.status === 'done') {
      m._finishedAt = Date.now();
      broadcast(m.code, { type: 'end', state: engine.publicState(m) });
      if (m._tick) { clearInterval(m._tick); m._tick = null; }
    } else {
      scheduleAfkCheck(m);
    }
  }
}

// Single watchdog per match: keeps bots moving and resolves any round that
// somehow stalled (a bot that never acted, a timer that never fired).
function startTicker(m) {
  if (m._tick) clearInterval(m._tick);
  m._tick = setInterval(() => {
    if (m.status !== 'playing') { clearInterval(m._tick); m._tick = null; return; }
    maybeRunBots(m);
  }, 600);
}

// --- routes ---
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'OPTIONS') return json(res, 204, {});

  // static
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return fs.readFile(path.join(PUBLIC, 'index.html'), (e, d) => {
      if (e) return json(res, 500, { error: 'no index' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  }
  if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, matches: matches.size });

  // POST /api/match  {name} -> {code, playerId}
  if (req.method === 'POST' && p === '/api/match') {
    const body = await readBody(req).catch(() => ({}));
    const code = newCode();
    const m = engine.createMatch({ code });
    m._createdAt = Date.now();
    const pid = 'p_' + crypto.randomBytes(5).toString('hex');
    engine.addPlayer(m, { id: pid, name: (body.name || 'Player').slice(0, 24) });
    matches.set(code, m);
    return json(res, 200, { code, playerId: pid });
  }

  // POST /api/match/:code/join  {name, asBot?} -> {playerId}
  let mm = p.match(/^\/api\/match\/([A-Z2-9]{4})\/join$/);
  if (req.method === 'POST' && mm) {
    const m = matches.get(mm[1]);
    if (!m) return json(res, 404, { error: 'match not found' });
    if (m.status !== 'lobby') return json(res, 409, { error: 'match already started' });
    const body = await readBody(req).catch(() => ({}));
    const pid = (body.asBot ? 'bot_' : 'p_') + crypto.randomBytes(5).toString('hex');
    try {
      engine.addPlayer(m, { id: pid, name: (body.name || 'Player').slice(0, 24), isBot: !!body.asBot });
    } catch (e) { return json(res, 409, { error: e.message }); }
    broadcast(m.code, { type: 'lobby', state: engine.publicState(m) });
    return json(res, 200, { code: m.code, playerId: pid });
  }

  // POST /api/match/:code/start -> fills bots, starts
  mm = p.match(/^\/api\/match\/([A-Z2-9]{4})\/start$/);
  if (req.method === 'POST' && mm) {
    const m = matches.get(mm[1]);
    if (!m) return json(res, 404, { error: 'match not found' });
    if (m.status !== 'lobby') return json(res, 409, { error: 'already started' });
    fillBots(m);
    engine.startMatch(m);
    broadcast(m.code, { type: 'start', state: engine.publicState(m) });
    scheduleAfkCheck(m);
    startTicker(m);
    return json(res, 200, { ok: true, state: engine.publicState(m) });
  }

  // GET /api/match/:code -> public state
  mm = p.match(/^\/api\/match\/([A-Z2-9]{4})$/);
  if (req.method === 'GET' && mm) {
    const m = matches.get(mm[1]);
    if (!m) return json(res, 404, { error: 'match not found' });
    return json(res, 200, engine.publicState(m));
  }

  // POST /api/match/:code/action  {playerId, action, x, y}
  mm = p.match(/^\/api\/match\/([A-Z2-9]{4})\/action$/);
  if (req.method === 'POST' && mm) {
    const m = matches.get(mm[1]);
    if (!m) return json(res, 404, { error: 'match not found' });
    const body = await readBody(req).catch(() => ({}));
    const r = engine.submitAction(m, body.playerId, body);
    if (!r.ok) return json(res, 400, r);
    broadcast(m.code, { type: 'pending', state: engine.publicState(m) });
    maybeRunBots(m);
    return json(res, 200, { ok: true, waiting: r.waiting });
  }

  // GET /api/match/:code/replay -> full log
  mm = p.match(/^\/api\/match\/([A-Z2-9]{4})\/replay$/);
  if (req.method === 'GET' && mm) {
    const m = matches.get(mm[1]);
    if (!m) return json(res, 404, { error: 'match not found' });
    return json(res, 200, engine.replay(m));
  }

  // GET /api/match/:code/verify -> re-simulate the replay and compare
  mm = p.match(/^\/api\/match\/([A-Z2-9]{4})\/verify$/);
  if (req.method === 'GET' && mm) {
    const m = matches.get(mm[1]);
    if (!m) return json(res, 404, { error: 'match not found' });
    const rep = engine.replay(m);
    const recomputed = engine.verifyReplay(rep);
    const recorded = (m.finalScores || []).map(s => ({ id: s.id, score: s.score, cells: s.cells }));
    const match = JSON.stringify(recomputed) === JSON.stringify(recorded);
    return json(res, 200, {
      code: m.code,
      verified: match,
      recorded,
      recomputed,
      rounds: rep.log.filter(e => e.events !== undefined).length
    });
  }

  json(res, 404, { error: 'not found' });
});

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x');
  const mm = u.pathname.match(/^\/ws\/([A-Z2-9]{4})$/);
  if (!mm) { socket.destroy(); return; }
  const code = mm[1];
  const key = req.headers['sec-websocket-key'];
  const accept = wsAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  if (!sockets.has(code)) sockets.set(code, new Set());
  sockets.get(code).add(socket);
  socket.on('data', buf => {
    const msg = wsDecode(buf);
    if (!msg) return;
    if (msg.type === 'close') { socket.destroy(); return; }
    if (msg.type === 'ping') {
      // Answer a ping with a pong so the connection is not dropped.
      try { socket.write(Buffer.from([0x8a, 0x00])); } catch (_) {}
    }
  });
  socket.on('close', () => {
    const set = sockets.get(code);
    if (set) set.delete(socket);
    // Mark this match's human players disconnected if no sockets remain, so a
    // bot-only or abandoned match still plays itself out.
    const m = matches.get(code);
    if (m && set && set.size === 0) {
      for (const p of m.players) {
        if (!p.isBot && p.connected) {
          p.connected = false;
          console.log('player ' + p.id + ' disconnected from ' + code);
        }
      }
      setTimeout(() => maybeRunBots(m), 300);
    }
  });
  socket.on('error', () => {});
});

server.listen(PORT, () => {
  console.log('Tide Pool listening on http://localhost:' + PORT);
});

module.exports = server;
