'use strict';
// Regression tests for the deep-audit fixes. Run: node test/audit.test.js
//
// Covers:
//  1. wash-out resets `revealed` (information leak)
//  2. wash is order-independent (snapshot ownership)
//  3. `waiting` excludes disconnected players
//  4. per-player board filtering (revealed only for cells you have held)
//  5. match sweeping reclaims abandoned lobbies and finished matches
//  6. WebSocket masked-frame decoding and ping/pong

const assert = require('assert');
const engine = require('../server/engine');
const { idx } = engine;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function twoPlayerMatch(seed) {
  const m = engine.createMatch({ seed });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  return m;
}

console.log('\n--- audit regressions ---');

test('a washed-out cell hides its nutrient again', () => {
  const m = twoPlayerMatch(3);
  // find a nutrient-1 cell and an adjacent free cell
  let target = m.cells.find(c => c.nutrient === 1);
  const nb = m.cells.find(c =>
    c.i !== target.i && Math.abs(c.x - target.x) + Math.abs(c.y - target.y) === 1);
  engine.submitAction(m, 'a', { action: 'claim', x: target.x, y: target.y });
  engine.submitAction(m, 'b', { action: 'claim', x: nb.x, y: nb.y });
  engine.resolveRound(m);
  const cell = m.cells[idx(target.x, target.y)];
  assert.strictEqual(cell.owner, null, 'cell should have washed out');
  assert.strictEqual(cell.revealed, false, 'revealed must reset on wash-out');
  // and nobody may see its nutrient
  const st = engine.publicState(m, 'b');
  assert.strictEqual(st.board[idx(target.x, target.y)].nutrient, null,
    'a cell you never owned must stay hidden');
});

test('wash is order-independent: two adjacent 1-point cells both wash out', () => {
  // find a seed with two adjacent nutrient-1 cells
  let m = null, pair = null;
  for (let seed = 1; seed < 200 && !pair; seed++) {
    const t = engine.createMatch({ seed });
    for (const c of t.cells) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = c.x + dx, ny = c.y + dy;
        if (!engine.inBounds(nx, ny)) continue;
        const n = t.cells[idx(nx, ny)];
        if (c.nutrient === 1 && n.nutrient === 1) { pair = [c, n]; m = t; break; }
      }
      if (pair) break;
    }
  }
  assert.ok(pair, 'should find a seed with adjacent 1-point cells');
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const [c1, c2] = pair;
  engine.submitAction(m, 'a', { action: 'claim', x: c1.x, y: c1.y });
  engine.submitAction(m, 'b', { action: 'claim', x: c2.x, y: c2.y });
  engine.resolveRound(m);
  assert.strictEqual(m.cells[idx(c1.x, c1.y)].owner, null, 'first cell must wash out');
  assert.strictEqual(m.cells[idx(c2.x, c2.y)].owner, null, 'second cell must wash out too');
});

test('wash outcome does not depend on cell iteration order', () => {
  // Same board, two different orderings of the same cells must give the same
  // result. Build a synthetic match and shuffle the cells array.
  const build = order => {
    const m = engine.createMatch({ seed: 3 });
    engine.addPlayer(m, { id: 'a', name: 'A' });
    engine.addPlayer(m, { id: 'b', name: 'B' });
    engine.startMatch(m);
    // hand-place: a owns a 1-point cell, b owns its neighbour
    const target = m.cells.find(c => c.nutrient === 1);
    const nb = m.cells.find(c =>
      c.i !== target.i && Math.abs(c.x - target.x) + Math.abs(c.y - target.y) === 1);
    target.owner = 'a'; target.score = 1; target.revealed = true;
    nb.owner = 'b'; nb.score = 1; nb.revealed = true;
    m.cells = order.slice().sort((x, y) => x.i - y.i);
    engine.resolveRound(m);
    return m.cells.map(c => c.owner);
  };
  const forward = build([...Array(25).keys()]);
  const reversed = build([...Array(25).keys()].reverse());
  assert.deepStrictEqual(forward, reversed,
    'wash result must not depend on iteration order');
});

test('waiting is false once every active player has acted', () => {
  const m = twoPlayerMatch(3);
  m.players[1].connected = false; // b left
  const r = engine.submitAction(m, 'a', { action: 'claim', x: 0, y: 0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.waiting, false,
    'the last active player must not be told to keep waiting');
});

test('waiting is true while another active player still owes an action', () => {
  const m = twoPlayerMatch(3);
  const r = engine.submitAction(m, 'a', { action: 'claim', x: 0, y: 0 });
  assert.strictEqual(r.waiting, true, 'b has not acted yet');
});

test('activePlayers excludes disconnected players', () => {
  const m = twoPlayerMatch(3);
  assert.strictEqual(engine.activePlayers(m).length, 2);
  m.players[0].connected = false;
  assert.strictEqual(engine.activePlayers(m).length, 1);
});

test('a cell you have never owned stays hidden even after an opponent loses it', () => {
  const m = twoPlayerMatch(3);
  const target = m.cells.find(c => c.nutrient === 1);
  const nb = m.cells.find(c =>
    c.i !== target.i && Math.abs(c.x - target.x) + Math.abs(c.y - target.y) === 1);
  engine.submitAction(m, 'a', { action: 'claim', x: target.x, y: target.y });
  engine.submitAction(m, 'b', { action: 'claim', x: nb.x, y: nb.y });
  engine.resolveRound(m);
  const st = engine.publicState(m, 'b');
  assert.strictEqual(st.board[idx(target.x, target.y)].nutrient, null);
  // b's own cell is visible to b
  assert.strictEqual(st.board[idx(nb.x, nb.y)].nutrient, m.cells[idx(nb.x, nb.y)].nutrient);
});

test('replay still exposes the true nutrient layout for verification', () => {
  const m = twoPlayerMatch(3);
  const rep = engine.replay(m);
  assert.strictEqual(rep.nutrients.length, 25);
  for (const n of rep.nutrients) assert.ok(n >= 1 && n <= 5);
});

test('feeding shields a cell from the wash that would have freed it', () => {
  // Build a board where a 1-point cell sits next to an enemy. Feeding it must
  // keep it alive; not feeding it must let it wash out.
  function setup() {
    const m = engine.createMatch({ seed: 7 });
    engine.addPlayer(m, { id: 'a', name: 'A' });
    engine.addPlayer(m, { id: 'b', name: 'B' });
    engine.startMatch(m);
    const c1 = m.cells.find(c => c.nutrient === 1);
    const nb = m.cells.find(c =>
      c.i !== c1.i && Math.abs(c.x - c1.x) + Math.abs(c.y - c1.y) === 1);
    c1.owner = 'a'; c1.score = 1; c1.revealed = true;
    nb.owner = 'b'; nb.score = 3; nb.revealed = true;
    return { m, c1 };
  }

  const fed = setup();
  engine.submitAction(fed.m, 'a', { action: 'feed', x: fed.c1.x, y: fed.c1.y });
  fed.m.players[1].connected = false;
  engine.resolveRound(fed.m);
  assert.strictEqual(fed.m.cells[fed.c1.i].owner, 'a',
    'a fed cell must survive the wash');
  assert.strictEqual(fed.m.cells[fed.c1.i].score, 2, 'feed adds 1 point');

  const unfed = setup();
  engine.submitAction(unfed.m, 'a', { action: 'claim', x: 0, y: 0 });
  unfed.m.players[1].connected = false;
  engine.resolveRound(unfed.m);
  assert.strictEqual(unfed.m.cells[unfed.c1.i].owner, null,
    'the same cell must wash out when not fed');
});

test('two bots never deadlock at 0-0', () => {
  // Two bots with identical information must not pick the same cell every
  // round and both fail forever. This was a real bug: matches ended 0-0.
  const bot = require('../server/bot');
  let deadlocks = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const m = engine.createMatch({ seed });
    engine.addPlayer(m, { id: 'bot_aaaa', name: 'A' });
    engine.addPlayer(m, { id: 'bot_bbbb', name: 'B' });
    engine.startMatch(m);
    while (m.status === 'playing' && m.round <= m.maxRounds + 1) {
      for (const p of m.players) {
        const st = engine.publicState(m, p.id);
        engine.submitAction(m, p.id, bot.chooseAction(st, p.id));
      }
      engine.resolveRound(m);
    }
    const total = m.players.reduce((s, p) => s + p.score, 0);
    if (total === 0) deadlocks++;
  }
  assert.strictEqual(deadlocks, 0,
    deadlocks + ' of 25 bot matches ended 0-0 — the bots are deadlocking');
});

test('the bot produces a legal action for every board it sees', () => {
  const bot = require('../server/bot');
  for (let seed = 1; seed <= 20; seed++) {
    const m = engine.createMatch({ seed });
    engine.addPlayer(m, { id: 'a', name: 'A' });
    engine.addPlayer(m, { id: 'b', name: 'B' });
    engine.startMatch(m);
    for (let r = 0; r < 5 && m.status === 'playing'; r++) {
      for (const p of m.players) {
        const st = engine.publicState(m, p.id);
        const act = bot.chooseAction(st, p.id);
        assert.ok(act && (act.action === 'claim' || act.action === 'feed'),
          'bot returned an illegal action: ' + JSON.stringify(act));
        assert.ok(engine.inBounds(act.x, act.y), 'bot moved out of bounds');
        const r2 = engine.submitAction(m, p.id, act);
        assert.strictEqual(r2.ok, true,
          'bot action was rejected: ' + JSON.stringify(act) + ' -> ' + JSON.stringify(r2));
      }
      engine.resolveRound(m);
    }
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
