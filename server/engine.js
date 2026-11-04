'use strict';
// Tide Pool - pure game engine. No I/O, no globals. Deterministic from seed.

const SIZE = 5;
const CELLS = SIZE * SIZE;
const MAX_ROUNDS = 20;
const FEED_CAP = 5;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function idx(x, y) { return y * SIZE + x; }
function inBounds(x, y) { return x >= 0 && x < SIZE && y >= 0 && y < SIZE; }

const NEIGHBORS = [];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const list = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (inBounds(nx, ny)) list.push(idx(nx, ny));
    }
    NEIGHBORS.push(list);
  }
}

function createMatch(opts) {
  const seed = (opts && opts.seed) || Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const cells = [];
  for (let i = 0; i < CELLS; i++) {
    cells.push({
      i,
      x: i % SIZE,
      y: Math.floor(i / SIZE),
      nutrient: 1 + Math.floor(rng() * 5),
      revealed: false,
      owner: null,
      score: 0
    });
  }
  return {
    code: (opts && opts.code) || '',
    seed,
    round: 0,
    maxRounds: MAX_ROUNDS,
    cells,
    players: [],
    pending: {},
    log: [],
    status: 'lobby',
    winner: null,
    finalScores: null
  };
}

function addPlayer(m, player) {
  if (m.players.length >= 4) throw new Error('match full');
  if (m.players.some(p => p.id === player.id)) throw new Error('duplicate player');
  m.players.push({
    id: player.id,
    name: player.name || player.id,
    color: player.color || ['#4dd0e1', '#ff8a65', '#aed581', '#ba68c8'][m.players.length],
    isBot: !!player.isBot,
    score: 0,
    cells: 0,
    connected: true
  });
  return m.players[m.players.length - 1];
}

function startMatch(m) {
  if (m.players.length < 2) throw new Error('need at least 2 players');
  m.status = 'playing';
  m.round = 1;
  m.log.push({ round: 1, type: 'start', players: m.players.map(p => p.name) });
  return m;
}

function playerById(m, id) { return m.players.find(p => p.id === id) || null; }

function cellAt(m, x, y) {
  if (!inBounds(x, y)) return null;
  return m.cells[idx(x, y)] || null;
}

function submitAction(m, playerId, action) {
  if (m.status !== 'playing') return { ok: false, error: 'match not playing' };
  if (m.pending[playerId]) return { ok: false, error: 'already submitted' };
  const p = playerById(m, playerId);
  if (!p) return { ok: false, error: 'unknown player' };

  if (!action || typeof action !== 'object') return { ok: false, error: 'bad action' };
  const kind = action.action;
  if (kind !== 'claim' && kind !== 'feed') return { ok: false, error: 'action must be claim or feed' };
  const x = action.x, y = action.y;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(x, y)) {
    return { ok: false, error: 'x/y out of bounds' };
  }

  const cell = cellAt(m, x, y);
  if (!cell) return { ok: false, error: 'no such cell' };

  if (kind === 'feed') {
    // You may only feed a cell you already own.
    if (cell.owner !== playerId) return { ok: false, error: 'you do not own that cell' };
  }

  m.pending[playerId] = { action: kind, x, y, locked: true };
  // "waiting" is true while somebody still has to act. Disconnected players
  // are excluded so the last active player is not told to wait forever.
  return { ok: true, waiting: countPending(m) < activePlayers(m).length };
}

function countPending(m) {
  return m.players.filter(p => m.pending[p.id]).length;
}

// Players who are still in the match. A disconnected player is skipped by
// allSubmitted so an abandoned match can finish, but they still count here
// for the "waiting" flag so the last active player is told the round is ready.
function activePlayers(m) {
  return m.players.filter(p => p.connected !== false);
}

function allSubmitted(m) {
  // A player who has disconnected (closed their socket, or went AFK over plain
  // HTTP) is skipped: the round resolves from whoever is still connected.
  const active = activePlayers(m);
  if (active.length === 0) return false;
  return active.every(p => m.pending[p.id]);
}

// Resolve one round. Mutates m, appends to m.log.
function resolveRound(m) {
  if (m.status !== 'playing') return null;
  const actions = {};
  for (const p of m.players) {
    const a = m.pending[p.id];
    if (a) actions[p.id] = a;
  }
  if (Object.keys(actions).length === 0) return null;

  const events = [];
  const round = m.round;

  // --- 1. Claims resolve simultaneously ---
  const claimCount = {};
  for (const pid of Object.keys(actions)) {
    const a = actions[pid];
    if (a.action === 'claim') {
      const k = idx(a.x, a.y);
      claimCount[k] = (claimCount[k] || 0) + 1;
    }
  }

  for (const pid of Object.keys(actions)) {
    const a = actions[pid];
    if (a.action !== 'claim') continue;
    const k = idx(a.x, a.y);
    const cell = m.cells[k];
    const p = playerById(m, pid);
    if (cell.owner !== null) {
      events.push({ type: 'claim_fail', player: pid, x: a.x, y: a.y, reason: 'occupied' });
    } else if (claimCount[k] > 1) {
      events.push({ type: 'claim_fail', player: pid, x: a.x, y: a.y, reason: 'contested' });
    } else {
      cell.owner = pid;
      cell.score = cell.nutrient;
      cell.revealed = true;
      events.push({ type: 'claim', player: pid, x: a.x, y: a.y, value: cell.nutrient });
    }
  }

  // --- 2. Feeds ---
  // Feeding adds 1 point (capped) AND shields the cell from this round's wash.
  // Without the shield, feeding is strictly worse than claiming a new cell
  // (a claim is worth 1-5, a feed only 1), so the action would never be the
  // right choice and half the game's decision space would be dead.
  const fedThisRound = {};
  for (const pid of Object.keys(actions)) {
    const a = actions[pid];
    if (a.action !== 'feed') continue;
    const k = idx(a.x, a.y);
    const cell = m.cells[k];
    if (cell.owner === pid && cell.score < FEED_CAP) {
      cell.score += 1;
      fedThisRound[k] = true;
      events.push({ type: 'feed', player: pid, x: a.x, y: a.y, value: cell.score });
    } else {
      events.push({ type: 'feed_fail', player: pid, x: a.x, y: a.y, reason: cell.owner !== pid ? 'not yours' : 'at cap' });
    }
  }

  // --- 3. Tide wash: owned cell adjacent to an opponent cell loses 1 ---
  // Snapshot ownership BEFORE any erosion so the wash is order-independent:
  // two mutually adjacent 1-point cells must both wash out, regardless of
  // which one the loop happens to visit first.
  const ownersBefore = m.cells.map(c => c.owner);
  const washed = [];
  for (const cell of m.cells) {
    if (ownersBefore[cell.i] === null) continue;
    // A cell that was fed this round is shielded from the wash.
    if (fedThisRound[cell.i]) continue;
    let touched = false;
    for (const n of NEIGHBORS[cell.i]) {
      const nbOwner = ownersBefore[n];
      if (nbOwner !== null && nbOwner !== ownersBefore[cell.i]) { touched = true; break; }
    }
    if (touched && cell.score > 0) {
      cell.score -= 1;
      if (cell.score === 0) {
        cell.owner = null;
        // The cell is neutral again, so its nutrient is hidden once more.
        cell.revealed = false;
        washed.push({ x: cell.x, y: cell.y });
      }
    }
  }
  if (washed.length) events.push({ type: 'wash', cells: washed });

  // --- 4. Recompute scores ---
  for (const p of m.players) { p.score = 0; p.cells = 0; }
  for (const cell of m.cells) {
    if (cell.owner === null) continue;
    const p = playerById(m, cell.owner);
    if (p) { p.score += cell.score; p.cells += 1; }
  }

  m.log.push({ round, events, scores: m.players.map(p => ({ id: p.id, score: p.score, cells: p.cells })) });
  m.pending = {};

  // --- 5. End conditions ---
  const allOwned = m.cells.every(c => c.owner !== null);
  if (allOwned || m.round >= m.maxRounds) {
    m.status = 'done';
    m.finalScores = m.players.map(p => ({ id: p.id, name: p.name, score: p.score, cells: p.cells }));
    const best = Math.max(...m.players.map(p => p.score));
    const top = m.players.filter(p => p.score === best);
    if (top.length === 1) {
      m.winner = top[0].id;
      m.log.push({ round, type: 'win', player: top[0].id, name: top[0].name, score: best });
    } else {
      const bestCells = Math.max(...top.map(p => p.cells));
      const top2 = top.filter(p => p.cells === bestCells);
      if (top2.length === 1) {
        m.winner = top2[0].id;
        m.log.push({ round, type: 'win', player: top2[0].id, name: top2[0].name, score: best, tiebreak: 'cells' });
      } else {
        m.winner = null;
        m.log.push({ round, type: 'draw', players: top2.map(p => p.id) });
      }
    }
  } else {
    m.round += 1;
  }

  return { round, events, scores: m.players.map(p => ({ id: p.id, score: p.score, cells: p.cells })) };
}

// ---- Views ----

function publicState(m, forPlayerId) {
  // A cell's nutrient is visible only to a player who has owned it. `revealed`
  // is reset when a cell washes out, so a cell you never held stays hidden even
  // after an opponent has held and lost it.
  const board = m.cells.map(c => ({
    x: c.x, y: c.y,
    nutrient: c.revealed ? c.nutrient : null,
    owner: c.owner,
    score: c.owner !== null ? c.score : null
  }));
  return {
    code: m.code,
    status: m.status,
    round: m.round,
    maxRounds: m.maxRounds,
    you: forPlayerId || null,
    players: m.players.map(p => ({
      id: p.id, name: p.name, color: p.color,
      isBot: p.isBot, score: p.score, cells: p.cells,
      submitted: !!m.pending[p.id]
    })),
    board,
    yourPending: forPlayerId ? (m.pending[forPlayerId] || null) : null,
    winner: m.winner,
    finalScores: m.finalScores
  };
}

function replay(m) {
  return {
    code: m.code,
    seed: m.seed,
    players: m.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
    nutrients: m.cells.map(c => c.nutrient),
    log: m.log,
    winner: m.winner,
    finalScores: m.finalScores
  };
}

module.exports = {
  SIZE, CELLS, MAX_ROUNDS, FEED_CAP,
  createMatch, addPlayer, startMatch, submitAction, resolveRound,
  allSubmitted, countPending, activePlayers, playerById, cellAt,
  publicState, replay, idx, inBounds
};
