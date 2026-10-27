const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const pr = require(`${OUT}/practice.js`);
const sw = require(`${OUT}/session-wire.js`);

const problem = (over = {}) => ({
  id: 'p1', statement: 'Why?', mode: 'recall', target: ['n_a'], created_at: '2026-10-27T10:00:01Z',
  attempts: [], outcome: null, verdict: '', rung: null, miss_class: null, retest: false, concluded_at: null,
  ...over,
});

test('decodePractice reads the Fase 9 contract and hides nothing it was not sent', () => {
  const st = pr.decodePractice({
    active_problem_id: 'p2',
    problems: [
      problem({outcome: 'solved', verdict: 'ok', rung: 'R2', miss_class: null, retest: false,
        model_solution: 'because', concluded_at: '2026-10-27T10:05:00Z',
        attempts: [{at: '2026-10-27T10:02:00Z', text: 'draft'}]}),
      problem({id: 'p2', mode: 'composition', target: ['n_a', 'n_b'], created_at: '2026-10-27T10:06:00Z'}),
    ],
  });
  assert.equal(st.active_problem_id, 'p2');
  assert.equal(st.problems.length, 2);
  assert.equal(st.problems[0].model_solution, 'because');
  assert.equal(st.problems[0].rung, 'R2');
  assert.deepEqual(st.problems[0].attempts, [{at: '2026-10-27T10:02:00Z', text: 'draft'}]);
  assert.equal(st.problems[1].model_solution, null, 'absent while active');
  assert.equal(st.problems[1].mode, 'composition');
  assert.equal(pr.activeProblem(st).id, 'p2');
});

test('decodePractice is defensive: junk, aliases, unknown enums, stale active id', () => {
  assert.deepEqual(pr.decodePractice(undefined), {active_problem_id: null, problems: []});
  assert.deepEqual(pr.decodePractice('x'), {active_problem_id: null, problems: []});
  const st = pr.decodePractice({
    active_problem_id: 'gone',
    problems: [
      null, 'junk', {statement: 'no id'},
      {id: 'q', mode: 'weird', targets: ['n_x', 3], outcome: 'solved_with_hints', rung: 3,
        miss_class: 'nope', retest: 'yes', attempts: ['plain', {content: 'alias'}, {text: '  '}]},
    ],
  });
  assert.equal(st.active_problem_id, null);
  assert.equal(st.problems.length, 1);
  const q = st.problems[0];
  assert.equal(q.mode, 'recall');
  assert.deepEqual(q.target, ['n_x']);
  assert.equal(q.outcome, 'solvedWithHints');
  assert.equal(q.rung, 'R3');
  assert.equal(q.miss_class, null);
  assert.equal(q.retest, false);
  assert.deepEqual(q.attempts.map((a) => a.text), ['plain', 'alias']);
  // An active id pointing at a concluded problem is not active.
  const closed = pr.decodePractice({active_problem_id: 'p1', problems: [problem({outcome: 'movedOn'})]});
  assert.equal(closed.active_problem_id, null);
});

test('decodeSession carries practice (empty state for TEACH sessions)', () => {
  assert.deepEqual(sw.decodeSession({id: 's', mode: 'TEACH'}).practice, {active_problem_id: null, problems: []});
  const s = sw.decodeSession({id: 's', mode: 'PRACTICE', practice: {active_problem_id: 'p1', problems: [problem()]}});
  assert.equal(s.practice.active_problem_id, 'p1');
});

test('practiceCounts: solved (with or without hints) over presented, dismissed excluded', () => {
  const st = pr.decodePractice({problems: [
    problem({id: 'a', outcome: 'solved'}), problem({id: 'b', outcome: 'solvedWithHints'}),
    problem({id: 'c', outcome: 'surrendered'}), problem({id: 'd', outcome: 'dismissed'}), problem({id: 'e'}),
  ]});
  assert.deepEqual(pr.practiceCounts(st), {solved: 2, total: 4});
});

test('attemptText recognises the Tentativa:/Attempt: prefix on user messages only', () => {
  assert.equal(pr.attemptText({role: 'user', content: 'Tentativa:\nmy idea'}), 'my idea');
  assert.equal(pr.attemptText({role: 'user', content: 'attempt: x'}), 'x');
  assert.equal(pr.attemptText({role: 'assistant', content: 'Tentativa:\nx'}), null);
  assert.equal(pr.attemptText({role: 'user', content: 'Próximo problema, por favor.'}), null);
});

test('buildPracticeTranscript orders messages, problems, attempts and conclusions by time', () => {
  const messages = [
    {id: 'm1', role: 'assistant', content: 'Vamos lá.', timestamp: '2026-10-27T10:00:00Z', created_at: '2026-10-27T10:00:00Z'},
    {id: 'm2', role: 'user', content: 'Tentativa:\ndraft', timestamp: '', created_at: '2026-10-27T10:02:00Z'},
    {id: 'sys', role: 'system', content: 'hidden', timestamp: '2026-10-27T10:03:00Z'},
    {id: 'm3', role: 'assistant', content: 'Boa. Fecho.', timestamp: '2026-10-27T10:05:30Z'},
    {id: 'm4', role: 'user', content: 'Próximo problema, por favor.', timestamp: '2026-10-27T10:06:00Z'},
  ];
  const practice = pr.decodePractice({active_problem_id: 'p2', problems: [
    problem({outcome: 'solved', concluded_at: '2026-10-27T10:05:00Z', model_solution: 's',
      attempts: [{at: '2026-10-27T10:02:00Z', text: 'draft'}, {at: '2026-10-27T10:04:00Z', text: 'final answer'}]}),
    problem({id: 'p2', created_at: '2026-10-27T10:06:30Z'}),
  ]});
  const items = pr.buildPracticeTranscript({messages, practice});
  assert.deepEqual(items.map((i) => i.key), [
    'm1', 'problem-p1', 'm2', 'attempt-p1-1', 'conclusion-p1', 'm3', 'm4', 'problem-p2',
  ]);
  const att = items.find((i) => i.key === 'm2');
  assert.equal(att.type, 'attempt');
  assert.equal(att.text, 'draft');
  assert.equal(att.problemId, 'p1');
});

test('buildPracticeTranscript: same timestamp puts the problem first; pending quiz goes last; answers render as cards', () => {
  const ts = '2026-10-27T10:00:00Z';
  const items = pr.buildPracticeTranscript({
    messages: [
      {id: 'm1', role: 'assistant', content: 'x', timestamp: ts},
      {id: 'm2', role: 'user', content: '{}', timestamp: '2026-10-27T10:01:00Z', quiz_id: 'q1'},
    ],
    practice: pr.decodePractice({problems: [problem({created_at: ts})]}),
    answers: {q1: {quiz_id: 'q1'}},
    pending_quiz: {quiz_id: 'q2'},
  });
  assert.deepEqual(items.map((i) => i.type), ['problem', 'message', 'answer', 'pending']);
});

test('dockState / dockSubmission: attempt, next, free text and busy', () => {
  const active = pr.dockState({activeProblemId: 'p', executionStatus: 'idle'});
  assert.deepEqual(active, {mode: 'attempt', busy: false, canNext: false, canDismiss: true});
  assert.deepEqual(pr.dockSubmission(active, '  my try '), {kind: 'attempt', content: 'my try'});
  assert.equal(pr.dockSubmission(active, '   '), null);

  const idle = pr.dockState({activeProblemId: null, executionStatus: 'completed'});
  assert.equal(idle.canNext, true);
  assert.equal(idle.canDismiss, false);
  assert.deepEqual(pr.dockSubmission(idle, ''), {kind: 'next', content: ''});
  assert.deepEqual(pr.dockSubmission(idle, 'why R2?'), {kind: 'text', content: 'why R2?'});

  for (const status of ['queued', 'running']) {
    const busy = pr.dockState({activeProblemId: null, executionStatus: status});
    assert.equal(busy.busy, true);
    assert.equal(busy.canNext, false);
    assert.equal(pr.dockSubmission(busy, ''), null);
  }
  assert.equal(pr.dockState({activeProblemId: null, executionStatus: 'idle', sending: true}).canNext, false);
  assert.equal(pr.dockState({activeProblemId: null, executionStatus: 'idle', pendingQuiz: true}).busy, true);
  // Dismissing stays possible while the agent runs (but not mid-send).
  assert.equal(pr.dockState({activeProblemId: 'p', executionStatus: 'running'}).canDismiss, true);
  assert.equal(pr.dockState({activeProblemId: 'p', executionStatus: 'idle', sending: true}).canDismiss, false);
});

test('dockKeyAction: Enter submits, Shift+Enter and IME do not, Esc asks to dismiss only with an active problem', () => {
  const active = pr.dockState({activeProblemId: 'p', executionStatus: 'idle'});
  const idle = pr.dockState({activeProblemId: null, executionStatus: 'idle'});
  assert.equal(pr.dockKeyAction(active, 'Enter'), 'submit');
  assert.equal(pr.dockKeyAction(active, 'Enter', {shift: true}), 'none');
  assert.equal(pr.dockKeyAction(active, 'Enter', {composing: true}), 'none');
  assert.equal(pr.dockKeyAction(active, 'Escape'), 'confirm-dismiss');
  assert.equal(pr.dockKeyAction(idle, 'Escape'), 'none');
  assert.equal(pr.dockKeyAction(idle, 'a'), 'none');
});

test('labels exist for every enum value in both locales', () => {
  for (const locale of ['pt-BR', 'en']) {
    for (const o of pr.OUTCOMES) assert.ok(pr.outcomeLabel(o, locale));
    for (const r of pr.RUNGS) assert.match(pr.rungLabel(r, locale), new RegExp(`^${r} · .+`));
    for (const m of pr.MISS_CLASSES) assert.ok(pr.missClassLabel(m, locale));
    for (const m of pr.PROBLEM_MODES) assert.ok(pr.problemModeLabel(m, locale));
  }
  assert.equal(pr.outcomeLabel('solvedWithHints', 'pt-BR'), 'Resolvido com dicas');
  assert.equal(pr.outcomeLabel('solvedWithHints', 'en'), 'Solved with hints');
  assert.equal(pr.outcomeLabel('solved', 'fr'), 'Resolvido', 'unknown locale falls back to PT-BR');
  assert.equal(pr.outcomeTone('solved'), 'success');
  assert.equal(pr.outcomeTone('surrendered'), 'danger');
  assert.equal(pr.outcomeTone('dismissed'), 'muted');
});
