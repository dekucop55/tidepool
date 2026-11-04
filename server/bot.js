'use strict';
// Tide Pool sample bot. Uses only the public state an agent can see.

const { SIZE, idx, inBounds } = require('./engine');

// Score a cell for `me` given the visible board.
function cellValue(state, me, x, y) {
  const i = idx(x, y);
  const cell = state.board[i];
  const mine = state.players.find(p => p.id === me);
  const opps = state.players.filter(p => p.id !== me);

  let v = 0;

  // 1. Base value: nutrient if revealed, expected value 3 if not.
  const nut = cell.nutrient === null ? 3 : cell.nutrient;
  v += nut * 1.0;

  // 2. Ownership
  if (cell.owner === me) {
    // My cell: feeding is safe value, but a lone cell next to enemies erodes.
    v = 1.5;
    let enemyAdj = 0, myAdj = 0;
    for (const n of neighbors(x, y)) {
      const nb = state.board[n];
      if (nb.owner === me) myAdj++;
      else if (nb.owner !== null) enemyAdj++;
    }
    if (enemyAdj > 0) v -= enemyAdj * 1.2;      // erosion risk
    if (myAdj > 0) v += myAdj * 0.8;            // cluster protection
  } else if (cell.owner !== null) {
    // Enemy cell: only worth contesting if I can take it later; skip for now.
    return -100;
  }

  // 3. Adjacency to my own cells (cluster bonus)
  let myAdj = 0, enemyAdj = 0;
  for (const n of neighbors(x, y)) {
    const nb = state.board[n];
    if (nb.owner === me) myAdj++;
    else if (nb.owner !== null) enemyAdj++;
  }
  v += myAdj * 1.5;
  v -= enemyAdj * 0.5;

  // 4. Late game: value the board more than growth.
  if (state.round > state.maxRounds * 0.6) v += nut * 0.5;

  // 5. Small noise so two identical bots do not mirror each other.
  v += (Math.random() - 0.5) * 0.3;

  return v;
}

function neighbors(x, y) {
  const out = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (inBounds(nx, ny)) out.push(idx(nx, ny));
  }
  return out;
}

function chooseAction(state, me) {
  const mine = state.players.find(p => p.id === me);
  const myCells = state.board.filter(c => c.owner === me);

  // No cells yet: claim the best free cell.
  if (myCells.length === 0) {
    let best = null, bestV = -Infinity;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = state.board[idx(x, y)];
        if (c.owner !== null) continue;
        const v = cellValue(state, me, x, y);
        if (v > bestV) { bestV = v; best = { action: 'claim', x, y }; }
      }
    }
    return best || { action: 'claim', x: 2, y: 2 };
  }

  // Compare best claim vs best feed.
  let bestClaim = null, bestClaimV = -Infinity;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = state.board[idx(x, y)];
      if (c.owner !== null) continue;
      const v = cellValue(state, me, x, y);
      if (v > bestClaimV) { bestClaimV = v; bestClaim = { action: 'claim', x, y }; }
    }
  }

  let bestFeed = null, bestFeedV = -Infinity;
  for (const c of myCells) {
    if (c.score !== null && c.score >= 5) continue;
    const v = cellValue(state, me, c.x, c.y);
    if (v > bestFeedV) { bestFeedV = v; bestFeed = { action: 'feed', x: c.x, y: c.y }; }
  }

  if (bestClaim && bestClaimV >= bestFeedV) return bestClaim;
  if (bestFeed) return bestFeed;
  return bestClaim || { action: 'feed', x: myCells[0].x, y: myCells[0].y };
}

module.exports = { chooseAction };
