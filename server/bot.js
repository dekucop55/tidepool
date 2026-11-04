'use strict';
// Tide Pool sample bot. Uses only the public state an agent can see.
//
// Strategy: score every legal move by what the board looks like one round
// later, then take the best. The wash is simulated, so the bot avoids moves
// that strand a cell next to an enemy and prefers moves that keep its
// territory connected.

const { SIZE, idx, inBounds } = require('./engine');

function neighbors(x, y) {
  const out = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (inBounds(nx, ny)) out.push(idx(nx, ny));
  }
  return out;
}

// Simulate the tide wash on a hypothetical board and return the resulting
// score for `me`. `owners` and `scores` are plain arrays so the real match
// state is never touched.
function projectScore(board, me) {
  const owners = board.map(c => c.owner);
  const scores = board.map(c => (c.owner === me ? (c.score || 0) : 0));
  // one round of erosion for cells touching an enemy
  for (let i = 0; i < board.length; i++) {
    if (owners[i] === null) continue;
    let touched = false;
    for (const n of neighbors(board[i].x, board[i].y)) {
      if (owners[n] !== null && owners[n] !== owners[i]) { touched = true; break; }
    }
    if (touched && scores[i] > 0) scores[i] -= 1;
  }
  let total = 0;
  for (let i = 0; i < board.length; i++) if (owners[i] === me) total += scores[i];
  return total;
}

// Value of claiming cell (x,y) for `me`, measured one round ahead.
function claimValue(state, me, x, y) {
  const i = idx(x, y);
  const cell = state.board[i];
  if (cell.owner !== null) return -Infinity;

  const nut = cell.nutrient === null ? 3 : cell.nutrient;

  // Build the board as it would look after this claim, then run the wash.
  const projected = state.board.map(c => ({ x: c.x, y: c.y, owner: c.owner, score: c.score }));
  projected[i].owner = me;
  projected[i].score = nut;
  const after = projectScore(projected, me);

  // Baseline: what the board looks like if I do nothing here.
  const before = projectScore(state.board, me);

  let v = (after - before) * 1.0;

  // Connectivity matters more than raw value: a cell with no enemy neighbour
  // never erodes, so weight friendly adjacency heavily.
  let myAdj = 0, enemyAdj = 0, freeAdj = 0;
  for (const n of neighbors(x, y)) {
    const nb = state.board[n];
    if (nb.owner === me) myAdj++;
    else if (nb.owner !== null) enemyAdj++;
    else freeAdj++;
  }
  v += myAdj * 1.2;
  v -= enemyAdj * 1.0;
  v += freeAdj * 0.4; // room to grow

  // Late game: consolidate rather than expand.
  if (state.round > state.maxRounds * 0.6) v += nut * 0.6;

  return v;
}

// Value of feeding my own cell (x,y).
function feedValue(state, me, x, y) {
  const i = idx(x, y);
  const cell = state.board[i];
  if (cell.owner !== me) return -Infinity;
  if (cell.score === null || cell.score >= 5) return -Infinity;

  // How many enemy neighbours does this cell have?
  let enemyAdj = 0;
  for (const n of neighbors(x, y)) {
    const nb = state.board[n];
    if (nb.owner !== null && nb.owner !== me) enemyAdj++;
  }

  // Feeding shields the cell from this round's wash. A cell next to an enemy
  // would otherwise lose 1, so feeding there is worth 2 (the +1 and the wash
  // it prevents). A cell with no enemy neighbour is only worth the +1.
  const washSaved = enemyAdj > 0 ? 1 : 0;
  const base = 1 + washSaved;

  // A cell at 1 point next to an enemy is about to wash out entirely: saving
  // it keeps the whole cell, not just a point.
  const rescue = (enemyAdj > 0 && cell.score <= 1) ? 2 : 0;

  return base + rescue;
}

function chooseAction(state, me) {
  const myCells = state.board.filter(c => c.owner === me);

  // Deterministic per-player tie-break. Two bots seeing the same board would
  // otherwise pick the exact same cell every round, both fail, and the match
  // deadlocks at 0-0 forever.
  const jitter = (function () {
    let h = 0;
    for (let i = 0; i < me.length; i++) h = (h * 31 + me.charCodeAt(i)) | 0;
    return function (k) {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      return ((h / 0x7fffffff) - 0.5) * 0.6 * (k + 1);
    };
  })();

  // No cells yet: take the best claim.
  if (myCells.length === 0) {
    let best = null, bestV = -Infinity;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const v = claimValue(state, me, x, y);
        if (v === -Infinity) continue;
        const vv = v + jitter(y * SIZE + x);
        if (vv > bestV) { bestV = vv; best = { action: 'claim', x, y }; }
      }
    }
    return best || { action: 'claim', x: 2, y: 2 };
  }

  let best = null, bestV = -Infinity;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = claimValue(state, me, x, y);
      if (v === -Infinity) continue;
      const vv = v + jitter(y * SIZE + x);
      if (vv > bestV) { bestV = vv; best = { action: 'claim', x, y }; }
    }
  }
  for (const c of myCells) {
    const v = feedValue(state, me, c.x, c.y);
    if (v === -Infinity) continue;
    const vv = v + jitter(c.i);
    if (vv > bestV) { bestV = vv; best = { action: 'feed', x: c.x, y: c.y }; }
  }

  // Fallback: feed anything of mine, else claim the centre.
  if (!best) {
    const c = myCells[0];
    return c ? { action: 'feed', x: c.x, y: c.y } : { action: 'claim', x: 2, y: 2 };
  }
  return best;
}

module.exports = { chooseAction };
