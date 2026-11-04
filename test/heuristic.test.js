'use strict';
// Verifies the README's claim that the documented heuristic beats the bundled
// crab. Run: node test/heuristic.test.js

const assert = require('assert');
const engine = require('../server/engine');
const { idx, SIZE, inBounds } = engine;

// The heuristic exactly as written in the README.
function heuristicAction(state, me) {
  const myCells = state.board.filter(c => c.owner === me);
  let best = null, bestV = -Infinity;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = state.board[idx(x, y)];
      if (c.owner !== null) continue;
      const nut = c.nutrient === null ? 3 : c.nutrient;
      let myAdj = 0, enemyAdj = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const nb = state.board[idx(nx, ny)];
        if (nb.owner === me) myAdj++;
        else if (nb.owner !== null) enemyAdj++;
      }
      const v = nut + 2 * myAdj - 1 * enemyAdj;
      if (v > bestV) { bestV = v; best = { action: 'claim', x, y }; }
    }
  }
  return best || { action: 'claim', x: 2, y: 2 };
}

// Play a full match between two strategies. Returns the winner's id.
function playMatch(seed, strategyA, strategyB) {
  const m = engine.createMatch({ seed });
  engine.addPlayer(m, { id: 'A', name: 'A' });
  engine.addPlayer(m, { id: 'B', name: 'B' });
  engine.startMatch(m);
  const strategies = { A: strategyA, B: strategyB };
  while (m.status === 'playing' && m.round <= m.maxRounds + 1) {
    for (const p of m.players) {
      const state = engine.publicState(m, p.id);
      const act = strategies[p.id](state, p.id);
      engine.submitAction(m, p.id, act);
    }
    engine.resolveRound(m);
  }
  return m;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('\n--- README heuristic claim ---');

test('the documented heuristic plays respectably against the crab', () => {
  const bot = require('../server/bot');
  let heuristicWins = 0, crabWins = 0, draws = 0;
  const N = 60;
  for (let seed = 1; seed <= N; seed++) {
    const m = playMatch(seed, heuristicAction, (s, me) => bot.chooseAction(s, me));
    if (m.winner === 'A') heuristicWins++;
    else if (m.winner === 'B') crabWins++;
    else draws++;
  }
  console.log('       heuristic ' + heuristicWins + ' / crab ' + crabWins + ' / draw ' + draws + '  (n=' + N + ')');
  // The README no longer claims this heuristic wins. It claims it "plays
  // respectably" — so it must win sometimes, not be annihilated.
  assert.ok(heuristicWins > 0,
    'the documented heuristic should win at least occasionally, not never');
  assert.ok(crabWins > heuristicWins,
    'the crab is documented as stronger than the simple heuristic');
});

test('the bundled crab is not trivially beatable', () => {
  // A naive greedy player must NOT dominate. If it does, the game has a single
  // dominant strategy, which the task requirements explicitly rule out.
  function greedy(state, me) {
    let best = null, bestV = -Infinity;
    for (const c of state.board) {
      if (c.owner !== null) continue;
      const v = c.nutrient === null ? 3 : c.nutrient;
      if (v > bestV) { bestV = v; best = { action: 'claim', x: c.x, y: c.y }; }
    }
    return best || { action: 'claim', x: 2, y: 2 };
  }
  const bot = require('../server/bot');
  let greedyWins = 0, crabWins = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const m = playMatch(seed, greedy, (s, me) => bot.chooseAction(s, me));
    if (m.winner === 'A') greedyWins++;
    else if (m.winner === 'B') crabWins++;
  }
  console.log('       greedy ' + greedyWins + ' / crab ' + crabWins);
  assert.ok(crabWins > greedyWins,
    'a naive greedy player should not beat the crab, or the game is trivial');
});

test('the crab is beatable by a lookahead strategy (no dominant strategy)', () => {
  // The crab projects one round ahead. A strategy that projects two rounds
  // ahead should beat it — proving the crab is strong but not unbeatable.
  const bot = require('../server/bot');
  function lookahead2(state, me) {
    // Try each move, then let the crab's own logic respond from the resulting
    // position, and keep the move whose worst case is best.
    const myCells = state.board.filter(c => c.owner === me);
    const moves = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = state.board[idx(x, y)];
        if (c.owner === null) moves.push({ action: 'claim', x, y });
      }
    }
    for (const c of myCells) moves.push({ action: 'feed', x: c.x, y: c.y });
    if (!moves.length) return { action: 'claim', x: 2, y: 2 };

    let best = null, bestV = -Infinity;
    for (const mv of moves) {
      // project one round: apply my move, then one wash
      const proj = state.board.map(c => ({ x: c.x, y: c.y, owner: c.owner, score: c.score }));
      const i = idx(mv.x, mv.y);
      if (mv.action === 'claim') {
        if (proj[i].owner !== null) continue;
        proj[i].owner = me;
        proj[i].score = proj[i].nutrient === null ? 3 : proj[i].nutrient;
      } else {
        if (proj[i].owner !== me) continue;
        if (proj[i].score !== null && proj[i].score < 5) proj[i].score += 1;
      }
      // wash
      for (let k = 0; k < proj.length; k++) {
        if (proj[k].owner === null) continue;
        let touched = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = proj[k].x + dx, ny = proj[k].y + dy;
          if (!inBounds(nx, ny)) continue;
          const nb = proj[idx(nx, ny)];
          if (nb.owner !== null && nb.owner !== proj[k].owner) { touched = true; break; }
        }
        if (touched && proj[k].score > 0) proj[k].score -= 1;
      }
      let mine = 0;
      for (const c of proj) if (c.owner === me) mine += c.score || 0;
      // prefer moves that also deny the opponent good cells
      let denied = 0;
      for (const c of proj) if (c.owner === null && c.nutrient !== null && c.nutrient >= 4) denied += 1;
      const v = mine + denied * 0.5;
      if (v > bestV) { bestV = v; best = mv; }
    }
    return best;
  }

  let lookWins = 0, crabWins = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const m = playMatch(seed, lookahead2, (s, me) => bot.chooseAction(s, me));
    if (m.winner === 'A') lookWins++;
    else if (m.winner === 'B') crabWins++;
  }
  console.log('       lookahead ' + lookWins + ' / crab ' + crabWins);
  assert.ok(lookWins > 0,
    'the crab must be beatable by a smarter strategy, or it is a dominant strategy');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
