const {test} = require('node:test');
const assert = require('node:assert/strict');
const sw = require('/tmp/learnharness-frontend-tests/session-wire.js');

test('pending quiz decodes the Fase 8 payload and the legacy aliases', () => {
  const q = sw.decodeQuiz({
    quiz_id: 'q1', session_id: 's', node_id: 'n1', topic: 'T', question: '?', details: null,
    kind: 'ask', mode: null, multi_select: true, created_at: 'x',
    choices: [{value: 'A', label: 'one', description: 'more'}, 'two'],
  });
  assert.equal(q.kind, 'ask');
  assert.equal(q.multi_select, true);
  assert.deepEqual(q.choices[1], {value: 'B', label: 'two'});
  assert.equal(q.choices[0].description, 'more');
  const legacy = sw.decodeQuiz({id: 'old', mode: 'CHECK', options: [{index: 0, label: 'A', text: 'x'}], plan_node_id: 'n'});
  assert.equal(legacy.quiz_id, 'old');
  assert.equal(legacy.kind, 'quiz');
  assert.equal(legacy.node_id, 'n');
  assert.equal(legacy.choices[0].label, 'x');
  const explain = sw.decodeQuiz({quiz_id: 'e', choices: []});
  assert.equal(explain.kind, 'explain');
});

test('old answers with a single chosen_index decode gracefully', () => {
  const a = sw.decodeAnswer({quiz_id: 'q', chosen_index: 2, correct_index: 1, correct: false, confidence: 90, mode: 'CHECK'});
  assert.deepEqual(a.chosen_indices, [2]);
  assert.deepEqual(a.correct_indices, [1]);
  assert.equal(a.kind, 'quiz');
  assert.equal(a.grade, null);
  assert.equal(a.reading_thinking, '');
});

test('plan decodes status/aliases and legacy phases normalize', () => {
  const plan = sw.decodePlan({nodes: [{id: 'a', title: 'A', dependencies: [], status: 'review'}, {id: 'b', label: 'B', depends_on: ['a'], status: 'visited', four_dimensions: {said: 'x', paragraph_refs: ['p1']}}]});
  assert.equal(plan.nodes[0].label, 'A');
  assert.equal(plan.nodes[0].status, 'needs_review');
  assert.deepEqual(plan.nodes[1].depends_on, ['a']);
  assert.deepEqual(plan.nodes[1].dimensions.source_anchors, ['p1']);
  assert.equal(sw.normalizePhase('awaiting_answer', true), 'teaching');
  assert.equal(sw.normalizePhase('awaiting_answer', false), 'probing');
  assert.equal(sw.normalizePhase('planning', false), 'planning');
});

test('transcript places probe card and phase dividers in order', () => {
  const msg = (id, role, created_at, extra = {}) => ({id, role, content: 'c', timestamp: created_at, created_at, ...extra});
  const answer = (quiz_id, mode, node_id) => ({quiz_id, kind: 'quiz', mode, node_id, chosen_indices: [0], correct_indices: [0]});
  const session = {
    mode: 'TEACH',
    messages: [
      msg('m1', 'assistant', '2026-01-01T00:00:01'),
      msg('m2', 'user', '2026-01-01T00:00:02', {quiz_id: 'p1'}),
      msg('m3', 'assistant', '2026-01-01T00:00:04'),
      msg('m4', 'user', '2026-01-01T00:00:05'),
      msg('m5', 'user', '2026-01-01T00:00:06', {quiz_id: 't1'}),
      msg('tool', 'tool', '2026-01-01T00:00:07'),
    ],
    answers: {p1: answer('p1', 'PROBE', null), t1: answer('t1', 'PREDICTION', 'n1')},
    assessment: {strands: [{strand: 's', assessment: 'ok'}], summary: null, created_at: '2026-01-01T00:00:03'},
    pending_quiz: {quiz_id: 'c1', kind: 'quiz', mode: 'CHECK', node_id: 'n1'},
  };
  const kinds = sw.buildTranscript(session).map((i) => (i.type === 'divider' ? `|${i.phase}` : i.type === 'message' ? i.key : i.type));
  assert.deepEqual(kinds, ['|probing', 'm1', 'answer', 'probe_done', '|planning', 'm3', 'm4', '|teaching', 'answer', 'pending']);
});

test('legacy JSON answer messages render as cards with their question', () => {
  const items = sw.buildTranscript({
    mode: 'TEACH', answers: {}, assessment: null, pending_quiz: null,
    messages: [{id: 'a', role: 'user', quiz_id: 'q', timestamp: '', content: JSON.stringify({quiz: 'Why?', chosen_index: 0, correct_index: 0, correct: true, confidence: 70})}],
  });
  const card = items.find((i) => i.type === 'answer');
  assert.equal(card.answer.question, 'Why?');
  assert.deepEqual(card.answer.chosen_indices, [0]);
});

test('answers sent as a list (current API) are keyed by quiz_id', () => {
  const s = sw.decodeSession({
    messages: [],
    answers: [{quiz_id: 'q9', kind: 'quiz', mode: 'CHECK', correct: true, chosen_indices: [0], correct_indices: [0], confidence: 70}],
  });
  assert.equal(Object.keys(s.answers).join(), 'q9');
  assert.equal(s.answers.q9.correct, true);
});
