const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const js = require(`${OUT}/job-steer.js`);
const sw = require(`${OUT}/session-wire.js`);
const pr = require(`${OUT}/practice.js`);

const T0 = '2026-10-27T10:00:00Z';
const T1 = '2026-10-27T10:00:42Z';

test('research result decodes brief, sources and elapsed time', () => {
  const job = js.decodeJobSteer({
    job_id: 'j1', kind: 'research', status: 'done', started_at: T0, finished_at: T1,
    result: {brief: '## Resumo\nok', sources: [{title: 'A', url: 'https://a.example'}, {url: 'https://b.example'}, 7]},
  });
  assert.equal(job.jobId, 'j1');
  assert.equal(job.kind, 'research');
  assert.equal(job.status, 'done');
  assert.equal(job.elapsedSeconds, 42);
  assert.deepEqual(job.result, {
    kind: 'research', brief: '## Resumo\nok',
    sources: [{title: 'A', url: 'https://a.example'}, {title: 'https://b.example', url: 'https://b.example'}],
  });
  assert.equal(js.dispatchLabel(job, 'pt-BR'), 'Despachado → concluído · 42 s');
  assert.equal(js.dispatchLabel(job, 'en'), 'Dispatched → done · 42 s');
  assert.equal(js.jobTitle(job, 'pt-BR'), 'Pesquisa concluída');
});

test('pdf accepts the read_pdf alias, sorts pages and keeps path/question', () => {
  const job = js.decodeJobSteer({
    job_id: 'j2', kind: 'read_pdf', status: 'done',
    result: {path: 'Fontes/paper.pdf', question: 'Q?', brief: 'answer (p. 3)', pages: [5, 3, '4', 3, -1, 'x']},
  });
  assert.equal(job.kind, 'pdf');
  assert.deepEqual(job.result, {kind: 'pdf', path: 'Fontes/paper.pdf', question: 'Q?', brief: 'answer (p. 3)', pages: [3, 4, 5]});
  assert.equal(js.formatPages([1, 3, 4, 5, 9, 10]), '1, 3–5, 9, 10');
  assert.equal(js.pdfFileName('Fontes/sub/paper.pdf'), 'paper.pdf');
});

test('visual and demo results; missing essentials fall back to a generic summary', () => {
  const vis = js.decodeJobSteer({job_id: 'j3', kind: 'visual', status: 'done', result: {svg: '<svg viewBox="0 0 1 1"/>', path: 'viz/visuals/a.svg'}});
  assert.equal(vis.result.kind, 'visual');
  assert.equal(vis.result.notes, null);
  assert.equal(js.visualFileName('viz/visuals/a.svg', 'j3'), 'a.svg');
  assert.equal(js.visualFileName('', 'j3'), 'j3.svg');

  const demo = js.decodeJobSteer({job_id: 'j4', kind: 'demo', status: 'done', result: {slug: 'pendulo', title: 'Pêndulo'}});
  assert.deepEqual(demo.result, {kind: 'demo', slug: 'pendulo', url: null, title: 'Pêndulo'});

  const empty = js.decodeJobSteer({job_id: 'j5', kind: 'visual', status: 'done', result: {path: 'x.svg'}});
  assert.equal(empty.result.kind, 'unknown');
  assert.match(empty.result.summary, /path: x\.svg/);
});

test('unknown kind, missing details and failures are tolerated', () => {
  const odd = js.decodeJobSteer({job_id: 'j6', kind: 'transcribe', status: 'done', result: {words: 12, text: 'hi', meta: {a: 1}}});
  assert.equal(odd.kind, null);
  assert.equal(odd.rawKind, 'transcribe');
  assert.equal(odd.result.kind, 'unknown');
  assert.equal(odd.result.summary, 'words: 12 · text: hi · meta: {1}');
  assert.equal(js.jobTitle(odd, 'en'), 'Job done');

  const none = js.decodeJobSteer(null, T1);
  assert.equal(none.status, 'done');
  assert.equal(none.result.kind, 'unknown');
  assert.equal(none.elapsedSeconds, null);
  assert.equal(js.dispatchLabel(none, 'pt-BR'), 'Despachado → concluído');

  const failed = js.decodeJobSteer({job_id: 'j7', kind: 'research', status: 'failed', error: 'sem engine', started_at: T0}, T1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result, null);
  assert.equal(failed.error, 'sem engine');
  assert.equal(failed.elapsedSeconds, 42, 'message created_at stands in for finished_at');
  assert.equal(js.dispatchLabel(failed, 'pt-BR'), 'Despachado → falhou · 42 s');
  assert.equal(js.jobTitle(failed, 'pt-BR'), 'Pesquisa falhou');

  const implicit = js.decodeJobSteer({kind: 'pdf', error: 'nada lido'});
  assert.equal(implicit.status, 'failed');
});

test('formatElapsed and svgDataUri', () => {
  assert.equal(js.formatElapsed(9), '9 s');
  assert.equal(js.formatElapsed(72), '1 min 12 s');
  assert.equal(js.formatElapsed(120), '2 min');
  assert.equal(js.formatElapsed(3720), '1 h 2 min');
  const uri = js.svgDataUri('<svg>é</svg>');
  assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
  assert.equal(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'), '<svg>é</svg>');
});

test('learner steer badge label', () => {
  assert.equal(js.learnerSteerLabel({steer_kind: 'learner', delivered: true}, 'pt-BR'), 'enviada durante o turno');
  assert.equal(js.learnerSteerLabel({steer_kind: 'learner', delivered: false}, 'pt-BR'), 'na fila');
  assert.equal(js.learnerSteerLabel({steer_kind: 'learner', delivered: false}, 'en'), 'queued');
  assert.equal(js.learnerSteerLabel({steer_kind: null}, 'pt-BR'), null);
  assert.equal(js.learnerSteerLabel({steer_kind: 'job'}, 'pt-BR'), null);
});

const msg = (over) => ({id: 'm', role: 'user', content: 'x', created_at: T0, ...over});

test('decodeSession normalizes steer fields; buildTranscript emits job items', () => {
  const session = sw.decodeSession({
    id: 's', mode: 'TEACH', answers: [], messages: [
      msg({id: 'm1', role: 'assistant', content: 'hello', created_at: '2026-10-27T10:00:01Z'}),
      msg({id: 'm2', content: 'and this?', created_at: '2026-10-27T10:00:02Z', steer_kind: 'learner', delivered: false}),
      msg({id: 'm3', content: 'A pesquisa terminou…', created_at: '2026-10-27T10:00:03Z', steer_kind: 'job',
        details: {job_id: 'j1', kind: 'research', status: 'done', result: {brief: 'b', sources: []}}}),
      msg({id: 'm4', content: 'plain', created_at: '2026-10-27T10:00:04Z', steer_kind: 'weird', details: 'nope'}),
    ],
  });
  const [, m2, m3, m4] = session.messages;
  assert.equal(m2.steer_kind, 'learner');
  assert.equal(m2.delivered, false);
  assert.equal(m4.steer_kind, null);
  assert.equal(m4.details, null);
  assert.equal(m4.delivered, true);
  assert.equal(m3.delivered, true);

  const items = sw.buildTranscript(session).filter((i) => i.type !== 'divider');
  assert.deepEqual(items.map((i) => i.type), ['message', 'message', 'job', 'message']);
  const job = items[2];
  assert.equal(job.key, 'm3');
  assert.equal(job.job.kind, 'research');
  assert.equal(items[1].message.steer_kind, 'learner');
});

test('practice transcript renders job steers as job items in time order', () => {
  const items = pr.buildPracticeTranscript({
    practice: {active_problem_id: null, problems: []},
    messages: [
      msg({id: 'a', role: 'assistant', content: 'go', created_at: '2026-10-27T10:00:01Z'}),
      msg({id: 'j', content: 'model text', created_at: '2026-10-27T10:00:05Z', steer_kind: 'job',
        details: {job_id: 'j2', kind: 'read_pdf', status: 'done', result: {brief: 'b', pages: [2]}}}),
      msg({id: 'u', content: 'Tentativa: x', created_at: '2026-10-27T10:00:03Z'}),
    ],
  });
  assert.deepEqual(items.map((i) => i.type), ['message', 'attempt', 'job']);
  assert.equal(items[2].job.kind, 'pdf');
});

test('backend Fase 10 shapes: visual by slug, PDF answer with pages_cited', () => {
  const visual = js.decodeJobSteer({job_id: 'j1', kind: 'visual', status: 'done',
    result: {slug: 'fluxo', path: 'viz/visuals/fluxo.svg', title: 'Fluxo', alt: 'logits'}}, '');
  assert.equal(visual.result.kind, 'visual');
  assert.equal(visual.result.slug, 'fluxo');
  assert.equal(visual.result.svg, '');
  const pdf = js.decodeJobSteer({job_id: 'j2', kind: 'read_pdf', status: 'done',
    result: {path: 'Fontes/paper.pdf', question: 'q', answer: 'diz isso (p. 2).', pages_cited: [2], pages_read: [2, 5]}}, '');
  assert.equal(pdf.result.kind, 'pdf');
  assert.deepEqual(pdf.result.pages, [2]);
});
