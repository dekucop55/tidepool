'use strict';
// Tide Pool test suite. Run: npm test
// Engine unit tests + full HTTP API flow test.

const assert = require('assert');
const engine = require('../server/engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('\n--- engine ---');

test('creates 25 cells with nutrient 1-5', () => {
  const m = engine.createMatch({ seed: 42 });
  assert.strictEqual(m.cells.length, 25);
  for (const c of m.cells) {
    assert.ok(c.nutrient >= 1 && c.nutrient <= 5, 'nutrient out of range: ' + c.nutrient);
    assert.strictEqual(c.owner, null);
    assert.strictEqual(c.revealed, false);
  }
});

test('deterministic from seed', () => {
  const a = engine.createMatch({ seed: 7 });
  const b = engine.createMatch({ seed: 7 });
  assert.deepStrictEqual(a.cells.map(c => c.nutrient), b.cells.map(c => c.nutrient));
});

test('needs 2 players to start', () => {
  const m = engine.createMatch({ seed: 1 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  assert.throws(() => engine.startMatch(m));
});

test('rejects duplicate player id', () => {
  const m = engine.createMatch({ seed: 1 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  assert.throws(() => engine.addPlayer(m, { id: 'a', name: 'A2' }));
});

test('caps at 4 players', () => {
  const m = engine.createMatch({ seed: 1 });
  for (let i = 0; i < 4; i++) engine.addPlayer(m, { id: 'p' + i, name: 'P' + i });
  assert.throws(() => engine.addPlayer(m, { id: 'x', name: 'X' }));
});

test('claim on a free cell succeeds and reveals nutrient', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const target = m.cells[12];
  engine.submitAction(m, 'a', { action: 'claim', x: target.x, y: target.y });
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  assert.strictEqual(target.owner, 'a');
  assert.strictEqual(target.score, target.nutrient);
  assert.strictEqual(target.revealed, true);
});

test('contested claim fails for both', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const t = m.cells[12];
  engine.submitAction(m, 'a', { action: 'claim', x: t.x, y: t.y });
  engine.submitAction(m, 'b', { action: 'claim', x: t.x, y: t.y });
  engine.resolveRound(m);
  assert.strictEqual(t.owner, null, 'cell should stay free');
  const fails = m.log[1].events.filter(e => e.type === 'claim_fail' && e.reason === 'contested');
  assert.strictEqual(fails.length, 2);
});

test('claim on occupied cell fails', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const t = m.cells[6];
  engine.submitAction(m, 'a', { action: 'claim', x: t.x, y: t.y });
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  // b tries to take a's cell; a plays somewhere harmless
  engine.submitAction(m, 'b', { action: 'claim', x: t.x, y: t.y });
  engine.submitAction(m, 'a', { action: 'claim', x: 4, y: 4 });
  const r = engine.resolveRound(m);
  const fails = r.events.filter(e => e.type === 'claim_fail' && e.reason === 'occupied');
  assert.strictEqual(fails.length, 1);
  assert.strictEqual(t.owner, 'a', 'cell should still belong to a');
});

test('feed adds 1 and caps at 5', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const t = m.cells[12];
  engine.submitAction(m, 'a', { action: 'claim', x: t.x, y: t.y });
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  const before = t.score;
  for (let i = 0; i < 8; i++) {
    engine.submitAction(m, 'a', { action: 'feed', x: t.x, y: t.y });
    engine.submitAction(m, 'b', { action: 'claim', x: 4 - t.x, y: 4 - t.y });
    engine.resolveRound(m);
  }
  assert.ok(t.score <= 5, 'score exceeded cap: ' + t.score);
  assert.ok(t.score > before, 'feed did nothing');
});

test('feed on enemy cell fails', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const t = m.cells[12];
  engine.submitAction(m, 'a', { action: 'claim', x: t.x, y: t.y });
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  // b tries to feed a's cell — rejected at submit time, not at resolve time.
  const r = engine.submitAction(m, 'b', { action: 'feed', x: t.x, y: t.y });
  assert.strictEqual(r.ok, false, 'feeding an enemy cell must be rejected');
  assert.ok(/own/.test(r.error), 'error should mention ownership: ' + r.error);
  // a's cell is untouched
  assert.strictEqual(t.owner, 'a');
  assert.strictEqual(t.score, t.nutrient);
});

test('double submit is rejected', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const r1 = engine.submitAction(m, 'a', { action: 'claim', x: 2, y: 2 });
  assert.strictEqual(r1.ok, true);
  const r2 = engine.submitAction(m, 'a', { action: 'claim', x: 3, y: 3 });
  assert.strictEqual(r2.ok, false, 'second submit in the same round must be rejected');
  assert.ok(/already/.test(r2.error), 'error should say already submitted: ' + r2.error);
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  const mine = m.cells.filter(c => c.owner === 'a');
  assert.strictEqual(mine.length, 1, 'the first action must be the one that counts');
  assert.strictEqual(mine[0].x, 2);
  assert.strictEqual(mine[0].y, 2);
});

test('wash erodes a lone cell next to an enemy', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  // a takes (1,1), b takes (2,1) - adjacent. B's cell has nutrient 1, so the
  // wash drops it to 0 and it drifts free in the SAME round. A's cell is then
  // no longer adjacent to an enemy, so it is untouched. Assert on b's cell.
  const bCell = m.cells[engine.idx(2, 1)];
  engine.submitAction(m, 'a', { action: 'claim', x: 1, y: 1 });
  engine.submitAction(m, 'b', { action: 'claim', x: 2, y: 1 });
  engine.resolveRound(m);
  assert.strictEqual(bCell.owner, null, 'b cell should have drifted free');
  const wash = m.log[1].events.find(e => e.type === 'wash');
  assert.ok(wash, 'a wash event should have fired');
  assert.strictEqual(wash.cells.length, 1);
});

test('wash frees a cell that reaches 0', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  // a takes (1,1) which has nutrient 3. b parks a cell next to it and FEEDS it
  // so it survives the wash, keeping the adjacency alive round after round.
  const t = m.cells[engine.idx(1, 1)];
  const bAnchor = m.cells[engine.idx(2, 1)];
  engine.submitAction(m, 'a', { action: 'claim', x: 1, y: 1 });
  engine.submitAction(m, 'b', { action: 'claim', x: 2, y: 1 });
  engine.resolveRound(m);
  // b's cell already drifted free in round 1 (nutrient 1). Re-take it and feed.
  let guard = 0;
  while (t.owner === 'a' && guard++ < 10) {
    if (bAnchor.owner !== 'b') {
      engine.submitAction(m, 'b', { action: 'claim', x: bAnchor.x, y: bAnchor.y });
    } else {
      engine.submitAction(m, 'b', { action: 'feed', x: bAnchor.x, y: bAnchor.y });
    }
    // a must act somewhere legal that does not disturb (1,1)
    const free = m.cells.filter(c => c.owner === null);
    const c = free[guard % free.length];
    engine.submitAction(m, 'a', { action: 'claim', x: c.x, y: c.y });
    engine.resolveRound(m);
  }
  assert.strictEqual(t.owner, null, 'cell should have drifted free');
  assert.ok(t.score === 0 || t.owner === null);
});

test('clustered cells do not erode each other', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  // a takes a 2x2 block far from b
  engine.submitAction(m, 'a', { action: 'claim', x: 0, y: 0 });
  engine.submitAction(m, 'b', { action: 'claim', x: 4, y: 4 });
  engine.resolveRound(m);
  engine.submitAction(m, 'a', { action: 'claim', x: 1, y: 0 });
  engine.submitAction(m, 'b', { action: 'claim', x: 3, y: 4 });
  engine.resolveRound(m);
  const c00 = m.cells[engine.idx(0, 0)], c10 = m.cells[engine.idx(1, 0)];
  const before = c00.score + c10.score;
  engine.submitAction(m, 'a', { action: 'claim', x: 0, y: 1 });
  engine.submitAction(m, 'b', { action: 'claim', x: 2, y: 4 });
  engine.resolveRound(m);
  assert.strictEqual(c00.score + c10.score, before, 'cluster should be untouched by wash');
});

test('rejects out of bounds and bad actions', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  assert.strictEqual(engine.submitAction(m, 'a', { action: 'claim', x: 9, y: 0 }).ok, false);
  assert.strictEqual(engine.submitAction(m, 'a', { action: 'nope', x: 0, y: 0 }).ok, false);
  assert.strictEqual(engine.submitAction(m, 'zzz', { action: 'claim', x: 0, y: 0 }).ok, false);
});

test('scores recompute correctly', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  engine.submitAction(m, 'a', { action: 'claim', x: 0, y: 0 });
  engine.submitAction(m, 'b', { action: 'claim', x: 4, y: 4 });
  engine.resolveRound(m);
  const a = m.players.find(p => p.id === 'a');
  assert.strictEqual(a.cells, 1);
  assert.strictEqual(a.score, m.cells[0].nutrient);
});

test('match ends at max rounds with a winner or draw', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  let guard = 0;
  while (m.status === 'playing' && guard++ < 100) {
    for (const p of m.players) {
      const free = m.cells.filter(c => c.owner === null);
      const mine = m.cells.filter(c => c.owner === p.id);
      if (free.length && Math.random() < 0.7) {
        const c = free[Math.floor(Math.random() * free.length)];
        engine.submitAction(m, p.id, { action: 'claim', x: c.x, y: c.y });
      } else if (mine.length) {
        const c = mine[Math.floor(Math.random() * mine.length)];
        engine.submitAction(m, p.id, { action: 'feed', x: c.x, y: c.y });
      } else {
        const c = free[0];
        engine.submitAction(m, p.id, { action: 'claim', x: c.x, y: c.y });
      }
    }
    engine.resolveRound(m);
  }
  assert.strictEqual(m.status, 'done');
  assert.ok(m.finalScores.length === 2);
  assert.ok(m.round <= m.maxRounds + 1);
});

test('public state hides unrevealed nutrients', () => {
  const m = engine.createMatch({ seed: 3 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const st = engine.publicState(m, 'a');
  assert.ok(st.board.every(c => c.nutrient === null), 'nothing revealed yet');
  engine.submitAction(m, 'a', { action: 'claim', x: 2, y: 2 });
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  const st2 = engine.publicState(m, 'a');
  const claimed = st2.board.find(c => c.x === 2 && c.y === 2);
  assert.ok(claimed.nutrient !== null, 'claimed cell should be revealed');
  const other = st2.board.find(c => c.x === 1 && c.y === 1);
  assert.strictEqual(other.nutrient, null, 'unclaimed stays hidden');
});

test('replay contains full log', () => {
  const m = engine.createMatch({ seed: 3, code: 'TEST' });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  engine.submitAction(m, 'a', { action: 'claim', x: 2, y: 2 });
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  const r = engine.replay(m);
  assert.strictEqual(r.code, 'TEST');
  assert.strictEqual(r.nutrients.length, 25);
  assert.ok(r.log.length >= 2);
});

console.log('\n--- bot ---');

test('bot returns a legal action', () => {
  const m = engine.createMatch({ seed: 11 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  const st = engine.publicState(m, 'a');
  const act = require('../server/bot').chooseAction(st, 'a');
  assert.ok(act.action === 'claim' || act.action === 'feed');
  assert.ok(Number.isInteger(act.x) && Number.isInteger(act.y));
  assert.ok(engine.inBounds(act.x, act.y));
});

test('bot never claims an owned cell', () => {
  const m = engine.createMatch({ seed: 11 });
  engine.addPlayer(m, { id: 'a', name: 'A' });
  engine.addPlayer(m, { id: 'b', name: 'B' });
  engine.startMatch(m);
  engine.submitAction(m, 'a', { action: 'claim', x: 2, y: 2 });
  engine.submitAction(m, 'b', { action: 'claim', x: 0, y: 0 });
  engine.resolveRound(m);
  const st = engine.publicState(m, 'a');
  const act = require('../server/bot').chooseAction(st, 'a');
  const cell = st.board[engine.idx(act.x, act.y)];
  if (act.action === 'claim') assert.strictEqual(cell.owner, null, 'bot claimed an owned cell');
  if (act.action === 'feed') assert.strictEqual(cell.owner, 'a', 'bot fed a foreign cell');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
