// Fase 23: per-turn usage of a session (GET /api/usage/sessions/{id}) and the popover bars.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = require('node:path').join(__dirname, '..', '.test-build');
const usage = require(`${OUT}/usage.js`);

const row = (turn, input, extra = {}) => ({turn, at: '2026-10-28T12:00:00+00:00', input_tokens: input, output_tokens: 0,
  thinking_tokens: 0, cached_tokens: null, calls: 1, ...extra});

test('decodeSessionTurns sorts turns, drops bad rows and keeps cache only when reported', () => {
  const out = usage.decodeSessionTurns({
    turns: [row(2, 50, {cached_tokens: 20}), row(1, 100), {turn: 'x'}, null, {turn: 1.5}],
    background: [{job_kind: 'extraction', input_tokens: 500, output_tokens: 50, calls: 2}, {job_kind: ''}, 7],
  });
  assert.deepEqual(out.turns.map((t) => t.turn), [1, 2]);
  assert.equal(out.turns[0].cached_tokens, null);
  assert.equal(out.turns[1].cached_tokens, 20);
  assert.deepEqual(out.background, [{job_kind: 'extraction', input_tokens: 500, output_tokens: 50,
    thinking_tokens: 0, cached_tokens: null, calls: 2}]);
});

test('decodeSessionTurns tolerates missing lists and rejects non-objects', () => {
  assert.deepEqual(usage.decodeSessionTurns({}), {turns: [], background: []});
  assert.equal(usage.decodeSessionTurns(null), null);
  assert.equal(usage.decodeSessionTurns([]), null);
});

test('turnBars keeps the last n turns, scaled to the most expensive one', () => {
  const turns = Array.from({length: 12}, (_, i) => row(i + 1, (i + 1) * 10));
  const bars = usage.turnBars(turns, 10);
  assert.deepEqual(bars.map((b) => b.turn), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(bars.at(-1).fraction, 1);
  assert.equal(bars[0].fraction, 30 / 120);
  assert.deepEqual(bars.filter((b) => b.peak).map((b) => b.turn), [12]);
});

test('turnBars marks only the first of tied peaks and handles all-zero turns', () => {
  const tied = usage.turnBars([row(1, 5), row(2, 9), row(3, 9)]);
  assert.deepEqual(tied.map((b) => b.peak), [false, true, false]);
  const zero = usage.turnBars([row(1, 0), row(2, 0)]);
  assert.deepEqual(zero.map((b) => [b.fraction, b.peak]), [[0, false], [0, false]]);
  assert.deepEqual(usage.turnBars([]), []);
});
