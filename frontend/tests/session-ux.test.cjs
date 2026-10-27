const {test} = require('node:test');
const assert = require('node:assert/strict');
const ux = require('/tmp/learnharness-frontend-tests/session-ux.js');
const sw = require('/tmp/learnharness-frontend-tests/session-wire.js');

test('fuzzyScore: subsequence, accent/case-insensitive, literal beats scattered', () => {
  assert.equal(ux.fuzzyScore('atn', 'Attention'), ux.fuzzyScore('atn', 'attention'));
  assert.ok(ux.fuzzyScore('atn', 'Attention') !== null);
  assert.equal(ux.fuzzyScore('xyz', 'Attention'), null);
  assert.ok(ux.fuzzyScore('atencao', 'Atenção multi-cabeça') !== null);
  assert.ok(ux.fuzzyScore('rope', 'RoPE e posições') > ux.fuzzyScore('rope', 'Rotary position embedding'));
  assert.equal(ux.fuzzyScore('', 'anything'), 0);
});

test('fuzzyFilter ranks best field first and keeps order for empty query', () => {
  const items = [
    {id: 'a', title: 'Gradiente descendente', topic: ''},
    {id: 'b', title: 'Transformers', topic: 'attention heads'},
    {id: 'c', title: 'Attention', topic: ''},
  ];
  const ids = (q) => ux.fuzzyFilter(items, q, (s) => [s.title, s.topic]).map((s) => s.id);
  assert.deepEqual(ids(''), ['a', 'b', 'c']);
  assert.deepEqual(ids('attention'), ['c', 'b']);
  assert.deepEqual(ids('zzz'), []);
});

test('moveCursor clamps and handles empty lists', () => {
  assert.equal(ux.moveCursor(-1, 3, 1), 0);
  assert.equal(ux.moveCursor(-1, 3, -1), 2);
  assert.equal(ux.moveCursor(2, 3, 1), 2);
  assert.equal(ux.moveCursor(0, 3, -1), 0);
  assert.equal(ux.moveCursor(0, 0, 1), -1);
});

test('resolveEsc follows question → problem → running, and yields to overlays', () => {
  const base = {overlayOpen: false, pendingQuestion: false, activeProblem: false, running: false};
  assert.equal(ux.resolveEsc(base), 'none');
  assert.equal(ux.resolveEsc({...base, running: true}), 'abort');
  assert.equal(ux.resolveEsc({...base, running: true, activeProblem: true}), 'dismiss-problem');
  assert.equal(ux.resolveEsc({...base, running: true, activeProblem: true, pendingQuestion: true}), 'dismiss-question');
  assert.equal(ux.resolveEsc({...base, running: true, pendingQuestion: true, overlayOpen: true}), 'none');
  assert.ok(ux.isRunningStatus('compacting'));
  assert.ok(!ux.isRunningStatus('waiting'));
});

test('findLiteral: literal, case-insensitive, non-overlapping offsets', () => {
  assert.deepEqual(ux.findLiteral('Attention is all; ATTENTION!', 'attention'), [
    {start: 0, end: 9},
    {start: 18, end: 27},
  ]);
  assert.deepEqual(ux.findLiteral('aaaa', 'aa'), [{start: 0, end: 2}, {start: 2, end: 4}]);
  assert.deepEqual(ux.findLiteral('a.b a*b', '.'), [{start: 1, end: 2}]);
  assert.deepEqual(ux.findLiteral('abc', ''), []);
  // Lower-casing "İ" changes the length: offsets stay on the original string.
  assert.deepEqual(ux.findLiteral('İx ab AB', 'ab'), [{start: 3, end: 5}, {start: 6, end: 8}]);
});

test('findInSegments maps matches back to text-node pieces, across nodes', () => {
  const segs = ['The **', 'soft', 'max** of soft', 'max'];
  const m = ux.findInSegments(segs, 'softmax');
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], [{segment: 1, start: 0, end: 4}, {segment: 2, start: 0, end: 3}]);
  assert.deepEqual(m[1], [{segment: 2, start: 9, end: 13}, {segment: 3, start: 0, end: 3}]);
  assert.deepEqual(ux.findInSegments(['abc'], 'zz'), []);
  assert.equal(ux.stepMatch(2, 3, 1), 0);
  assert.equal(ux.stepMatch(0, 3, -1), 2);
  assert.equal(ux.stepMatch(-1, 0, 1), -1);
});

test('steer queue: send → accepted removes; failed stays; echo hides a sending entry', () => {
  let s = ux.steerReducer([], {type: 'send', localId: 'l1', content: 'mais devagar', baseline: 2});
  assert.equal(s[0].status, 'sending');
  s = ux.steerReducer(s, {type: 'send', localId: 'l2', content: 'exemplo?', baseline: 2});
  s = ux.steerReducer(s, {type: 'failed', localId: 'l2'});
  assert.deepEqual(s.map((x) => [x.localId, x.status]), [['l1', 'sending'], ['l2', 'failed']]);
  const messages = [
    {id: 'm1', role: 'user', content: 'mais devagar'},
    {id: 'm2', role: 'assistant', content: 'ok'},
    {id: 'm3', role: 'user', content: ' mais devagar ', steer_kind: 'learner', delivered: false},
  ];
  // m1 is before the baseline, m3 is the echo.
  assert.deepEqual(ux.visibleLocalSteers(s, messages).map((x) => x.localId), ['l2']);
  assert.deepEqual(ux.visibleLocalSteers(s, messages.slice(0, 2)).map((x) => x.localId), ['l1', 'l2']);
  s = ux.steerReducer(s, {type: 'accepted', localId: 'l1'});
  s = ux.steerReducer(s, {type: 'send', localId: 'l2', content: 'exemplo?', baseline: 3});
  assert.deepEqual(s.map((x) => [x.localId, x.status]), [['l2', 'sending']]);
  s = ux.steerReducer(s, {type: 'discard', localId: 'l2'});
  assert.deepEqual(s, []);
});

test('compaction decode and divider anchor', () => {
  assert.equal(ux.decodeCompaction(null), null);
  assert.equal(ux.decodeCompaction({first_kept_message_id: 'x'}), null);
  const c = ux.decodeCompaction({summary: 's', first_kept_message_id: 'm2', tokens_before: 90000, at: '2026-01-01'});
  assert.deepEqual(c, {summary: 's', first_kept_message_id: 'm2', tokens_before: 90000, at: '2026-01-01'});
  const msgs = [{id: 'm1', role: 'user'}, {id: 'm2', role: 'tool'}, {id: 'm3', role: 'assistant'}];
  assert.equal(ux.compactionAnchorId(msgs, c), 'm3');
  assert.equal(ux.compactionAnchorId(msgs, {first_kept_message_id: 'zz'}), null);
  assert.equal(ux.compactionAnchorId(msgs, null), null);
  const session = sw.decodeSession({id: 's', compaction: {summary: 'x', first_kept_message_id: 'm1', at: ''}, answers: [{quiz_id: 'q', dismissed: true}]});
  assert.equal(session.compaction.first_kept_message_id, 'm1');
  assert.equal(session.answers.q.dismissed, true);
});

test('rowStatus priorities and relative time', () => {
  const row = (o) => ({mode: 'TEACH', execution_status: 'idle', updated_at: '2026-01-01T00:00:00Z', ...o});
  assert.equal(ux.rowStatus(row({execution_status: 'failed'})).kind, 'failed');
  assert.equal(ux.rowStatus(row({execution_status: 'compacting'})).kind, 'compacting');
  assert.equal(ux.rowStatus(row({execution_status: 'running', pending_quiz: {quiz_id: 'q'}})).kind, 'waiting');
  assert.equal(ux.rowStatus(row({execution_status: 'running'})).kind, 'working');
  assert.equal(ux.rowStatus(row({mode: 'PRACTICE', practice: {active_problem_id: 'p1'}})).kind, 'problem');
  assert.equal(ux.rowStatus(row({mode: 'PRACTICE', pending: true})).kind, 'problem');
  assert.equal(ux.rowStatus(row({pending: true})).kind, 'waiting');
  assert.deepEqual(ux.rowStatus(row({})), {kind: 'idle', updatedAt: '2026-01-01T00:00:00Z'});
  const now = Date.parse('2026-01-01T02:00:00Z');
  assert.match(ux.relativeTime('2026-01-01T00:00:00Z', now, 'en'), /2 hr/);
  assert.equal(ux.relativeTime('nope', now, 'en'), '');
  assert.deepEqual(ux.filterByMode([{mode: 'TEACH'}, {mode: 'PRACTICE'}], 'PRACTICE'), [{mode: 'PRACTICE'}]);
});

test('normalizeTitle trims, collapses spaces and rejects empty/unchanged/too long', () => {
  assert.equal(ux.normalizeTitle('  Nova   aula ', 'Velha'), 'Nova aula');
  assert.equal(ux.normalizeTitle('   ', 'Velha'), null);
  assert.equal(ux.normalizeTitle('Velha', 'Velha'), null);
  assert.equal(ux.normalizeTitle('x'.repeat(201), 'Velha'), null);
});
