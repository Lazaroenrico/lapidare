const {test} = require('node:test');
const assert = require('node:assert/strict');
const qc = require('../.test-build/question-core.js');

test('shuffle is deterministic per quiz_id and a permutation', () => {
  const a = qc.shuffleOrder(5, 'quiz-abc');
  assert.deepEqual(qc.shuffleOrder(5, 'quiz-abc'), a, 'same seed → same order');
  assert.deepEqual([...a].sort(), [0, 1, 2, 3, 4]);
  // Across many ids, some order must differ from identity and from each other.
  const orders = new Set(Array.from({length: 20}, (_, i) => qc.shuffleOrder(4, `q${i}`).join('')));
  assert.ok(orders.size > 1, 'different seeds produce different orders');
  assert.deepEqual(qc.shuffleOrder(0, 'x'), []);
  assert.deepEqual(qc.shuffleOrder(1, 'x'), [0]);
});

test('display positions map back to original indices', () => {
  const order = [2, 0, 3, 1]; // display 0 shows original 2, …
  assert.deepEqual(qc.toOriginalIndices(order, [0]), [2]);
  assert.deepEqual(qc.toOriginalIndices(order, [3, 0, 0]), [1, 2]);
  assert.deepEqual(qc.toOriginalIndices(order, [9]), []);
  const seeded = qc.shuffleOrder(6, 'quiz-xyz');
  for (let d = 0; d < 6; d++) assert.deepEqual(qc.toOriginalIndices(seeded, [d]), [seeded[d]]);
});

test('confidence is a free choice in 0..100 (no snapping to fixed stops)', () => {
  assert.equal(qc.DEFAULT_CONFIDENCE, 50);
  const cases = [[0, 0], [14, 14], [41, 41], [63.4, 63], [100, 100], [-5, 0], [130, 100]];
  for (const [input, want] of cases) assert.equal(qc.clampConfidence(input), want, `clamp(${input})`);
  assert.equal(qc.clampConfidence(Number.NaN), 50);
  assert.equal(qc.stepConfidence(50, 1), 55);
  assert.equal(qc.stepConfidence(44, -1), 39);
  assert.equal(qc.stepConfidence(98, 1), 100);
  assert.equal(qc.stepConfidence(2, -1), 0);
});

const draft = (over = {}) => ({
  selected: [], dontKnow: false, confidence: 50, thinking: '', readingThinking: '',
  text: '', otherSelected: false, otherText: '', ...over,
});

test('quiz submission maps the shuffled pick and carries both thinking channels', () => {
  const quiz = {quiz_id: 'q1', session_id: 's1', kind: 'quiz'};
  const sub = qc.buildSubmission(quiz, 's1', [2, 0, 1], draft({selected: [0], confidence: 77, thinking: ' because ', readingThinking: ' hmm '}));
  assert.deepEqual(sub, {
    quiz_id: 'q1', session_id: 's1', chosen_indices: [2], is_dont_know: false, confidence: 77,
    learner_thinking: 'because', reading_thinking: 'hmm', text: '', other_text: '',
  });
});

test('"Não sei" disables confidence and choices; explain has no confidence', () => {
  const quiz = {quiz_id: 'q', session_id: 's', kind: 'quiz'};
  const dk = qc.buildSubmission(quiz, 's', [0, 1], draft({dontKnow: true, selected: [1]}));
  assert.equal(dk.is_dont_know, true);
  assert.equal(dk.confidence, null);
  assert.deepEqual(dk.chosen_indices, []);
  const ex = qc.buildSubmission({...quiz, kind: 'explain'}, 's', [], draft({text: ' my answer '}));
  assert.equal(ex.confidence, null);
  assert.equal(ex.text, 'my answer');
  assert.equal(qc.canSubmit('explain', draft()), false);
  assert.equal(qc.canSubmit('explain', draft({dontKnow: true})), true);
  assert.equal(qc.canSubmit('quiz', draft()), false);
  assert.equal(qc.canSubmit('quiz', draft({selected: [0]})), true);
});

test('ask keeps order, has no Não sei/confidence, and sends "Outro…" text', () => {
  assert.equal(qc.shufflesOptions('ask'), false);
  assert.equal(qc.allowsDontKnow('ask'), false);
  const quiz = {quiz_id: 'a', session_id: 's', kind: 'ask'};
  assert.equal(qc.canSubmit('ask', draft({otherSelected: true})), false, 'Outro needs text');
  const sub = qc.buildSubmission(quiz, 's', [0, 1, 2], draft({otherSelected: true, otherText: ' mine ', dontKnow: true}));
  assert.equal(sub.other_text, 'mine');
  assert.equal(sub.is_dont_know, false);
  assert.equal(sub.confidence, null);
});

test('row navigation wraps around', () => {
  assert.equal(qc.moveRow(0, 1, 3), 1);
  assert.equal(qc.moveRow(2, 1, 3), 0);
  assert.equal(qc.moveRow(0, -1, 3), 2);
  assert.equal(qc.moveRow(-1, 1, 3), 0);
  assert.equal(qc.moveRow(-1, -1, 3), 2);
});
