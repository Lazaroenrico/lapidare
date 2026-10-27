// Fase 14: várias trilhas — decoding, progress, ordering, colours, sidebar filter, roadmap, creation.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const tr = require(`${OUT}/tracks.js`);
const i18n = require(`${OUT}/tracks-i18n.js`);
const gw = require(`${OUT}/graph-wire.js`);
const {decodeSetup, encodeConfig} = require(`${OUT}/config-wire.js`);
const {isGithubRepoUrl} = require(`${OUT}/import-wire.js`);

const wire = (over = {}) => ({
  id: 'trk-aaaa0001', title: 'Cálculo II', source: 'goal', mode: 'goal_generated', archived: false,
  active: false, created_at: '2026-10-01T10:00:00Z', progress: {done: 2, total: 5},
  next_item: {id: 'i3', title: 'Regra da cadeia'}, generating: false, error: null, ...over,
});

test('decodeTrack is defensive about every field', () => {
  assert.equal(tr.decodeTrack(null), null);
  assert.equal(tr.decodeTrack({title: 'sem id'}), null);
  const t = tr.decodeTrack({id: 'trk-1', source: 'weird', progress: {done: 9, total: '4'}, next_item: {title: 'x'}, error: '  '});
  assert.equal(t.title, 'trk-1');
  assert.equal(t.source, 'goal');
  assert.deepEqual(t.progress, {done: 4, total: 4});
  assert.equal(t.next_item, null);
  assert.equal(t.error, null);
  assert.equal(t.generating, false);
  assert.equal(t.archived, false);
  const full = tr.decodeTrack(wire({error: 'boom', generating: true}));
  assert.deepEqual(full.next_item, {id: 'i3', title: 'Regra da cadeia'});
  assert.equal(full.error, 'boom');
  assert.equal(full.generating, true);
  assert.deepEqual(tr.decodeTrack({id: 'x', progress: {done: -3, total: NaN}}).progress, {done: 0, total: 0});
});

test('decodeTracks accepts {tracks}, drops duplicates and keeps a single active', () => {
  const list = tr.decodeTracks({tracks: [wire({active: true}), wire(), wire({id: 'trk-2', active: true}), 'junk']});
  assert.deepEqual(list.map((t) => t.id), ['trk-aaaa0001', 'trk-2']);
  assert.deepEqual(list.map((t) => t.active), [true, false]);
  // active_track_id wins over the per-item flag.
  const byId = tr.decodeTracks([wire({active: true}), wire({id: 'trk-2'})], 'trk-2');
  assert.deepEqual(byId.map((t) => t.active), [false, true]);
  assert.deepEqual(tr.decodeTracks(undefined), []);
});

test('progress ratio, label and completion', () => {
  assert.equal(tr.progressRatio({done: 2, total: 5}), 0.4);
  assert.equal(tr.progressRatio({done: 0, total: 0}), 0);
  assert.equal(tr.progressLabel({done: 2, total: 5}), '2/5');
  assert.equal(tr.isTrackComplete({done: 5, total: 5}), true);
  assert.equal(tr.isTrackComplete({done: 0, total: 0}), false);
});

test('ordering: active first, then by creation, archived last; switcher hides archived', () => {
  const tracks = tr.decodeTracks([
    wire({id: 'old', created_at: '2026-01-01'}),
    wire({id: 'arch', created_at: '2025-01-01', archived: true}),
    wire({id: 'act', created_at: '2026-09-01', active: true}),
    wire({id: 'new', created_at: '2026-10-01'}),
  ]);
  assert.deepEqual(tr.orderTracks(tracks).map((t) => t.id), ['act', 'old', 'new', 'arch']);
  assert.deepEqual(tr.switchableTracks(tracks).map((t) => t.id), ['act', 'old', 'new']);
  assert.equal(tr.findActiveTrack(tracks).id, 'act');
  // An archived "active" track is not in focus.
  assert.equal(tr.findActiveTrack(tr.decodeTracks([wire({active: true, archived: true})])), null);
});

test('per-track tones are stable by creation and come from the palette', () => {
  const a = wire({id: 'a', created_at: '2026-01-01'});
  const b = wire({id: 'b', created_at: '2026-02-01'});
  const c = wire({id: 'c', created_at: '2026-03-01', archived: true});
  const tones = tr.trackTones(tr.decodeTracks([c, b, a]));
  assert.equal(tones.get('a'), tr.TRACK_TONES[0]);
  assert.equal(tones.get('b'), tr.TRACK_TONES[1]);
  assert.equal(tones.get('c'), tr.TRACK_TONES[2]);
  // Same input order-independent.
  assert.deepEqual([...tr.trackTones(tr.decodeTracks([a, b, c])).entries()], [...tones.entries()]);
  // Unknown ids (roadmap only) get a deterministic palette tone; none → muted.
  assert.ok(tr.TRACK_TONES.includes(tr.toneForTrack('trk-zzz', tones)));
  assert.equal(tr.toneForTrack('trk-zzz', tones), tr.toneForTrack('trk-zzz', new Map()));
  assert.equal(tr.toneForTrack(null, tones), 'mutedForeground');
});

test('short tag cuts at a word boundary', () => {
  assert.equal(tr.shortTrackTag('Cálculo II'), 'Cálculo II');
  assert.equal(tr.shortTrackTag('Engenharia de Machine Learning', 14), 'Engenharia de…');
  assert.ok(tr.shortTrackTag('Supercalifragilisticexpialidocious', 10).length <= 10);
});

test('sidebar filter: all / none / per track, with removed tracks falling back', () => {
  const sessions = [{id: 1, track_id: 'a'}, {id: 2, track_id: null}, {id: 3}, {id: 4, track_id: 'b'}, {id: 5, track_id: 'gone'}];
  assert.equal(tr.filterByTrack(sessions, 'all').length, 5);
  assert.deepEqual(tr.filterByTrack(sessions, 'none').map((s) => s.id), [2, 3]);
  assert.deepEqual(tr.filterByTrack(sessions, tr.trackFilterFor('a')).map((s) => s.id), [1]);
  const tracks = tr.decodeTracks([wire({id: 'a'}), wire({id: 'b'})]);
  assert.equal(tr.sanitizeTrackFilter('track:gone', tracks), 'all');
  assert.equal(tr.sanitizeTrackFilter('track:a', tracks), 'track:a');
  assert.equal(tr.sanitizeTrackFilter('none', []), 'none');
  assert.equal(tr.parseTrackFilter('garbage'), 'all');
  assert.equal(tr.parseTrackFilter(null), 'all');
  assert.equal(tr.parseTrackFilter('track:b'), 'track:b');
  assert.deepEqual(tr.resolveTrackRef('gone', tracks), {kind: 'removed'});
  assert.deepEqual(tr.resolveTrackRef(null, tracks), {kind: 'none'});
  assert.equal(tr.resolveTrackRef('a', tracks).track.id, 'a');
});

test('roadmap ids, scope filter and legend', () => {
  assert.deepEqual(tr.parseRoadmapId('track:trk-1:i3'), {trackId: 'trk-1', itemId: 'i3'});
  assert.deepEqual(tr.parseRoadmapId('track:i3'), {trackId: null, itemId: 'i3'});
  assert.deepEqual(tr.parseRoadmapId('track:trk-1:w1:i3', 'trk-1'), {trackId: 'trk-1', itemId: 'w1:i3'});
  assert.equal(gw.trackItemIdOf('track:trk-1:i3', 'trk-1'), 'i3');
  assert.equal(gw.trackItemIdOf('track:i2'), 'i2');

  const items = [
    {id: 'track:a:1', track_id: 'a', track_title: 'A'},
    {id: 'track:a:2', track_id: 'a', track_title: 'A'},
    {id: 'track:b:1', track_id: 'b', track_title: ''},
    {id: 'track:x'},
  ];
  assert.deepEqual(tr.filterRoadmap(items, 'focus', 'a').map((i) => i.id), ['track:a:1', 'track:a:2', 'track:x']);
  assert.equal(tr.filterRoadmap(items, 'all', 'a').length, 4);
  assert.equal(tr.filterRoadmap(items, 'focus', null).length, 4);
  const legend = tr.roadmapLegend(items, tr.trackTones(tr.decodeTracks([wire({id: 'a'})])));
  assert.deepEqual(legend.map((e) => [e.trackId, e.title, e.count]), [['a', 'A', 2], ['b', 'b', 1]]);
  assert.equal(legend[0].tone, tr.TRACK_TONES[0]);
});

test('decodeGraph keeps track_id / track_title on roadmap items', () => {
  const g = gw.decodeGraph({nodes: [], edges: [], roadmap: [
    {id: 'track:trk-1:i1', title: 'Derivadas', status: 'pending', track_id: 'trk-1', track_title: 'Cálculo'},
    {id: 'track:i2', title: 'Old', status: 'pending'},
  ]});
  assert.equal(g.roadmap[0].track_id, 'trk-1');
  assert.equal(g.roadmap[0].track_title, 'Cálculo');
  assert.equal(g.roadmap[1].track_id, null);
});

test('topic list parsing strips bullets, numbering and duplicates', () => {
  assert.deepEqual(tr.parseTopicList('- Limites\n* Derivadas\n\n1. Integrais\n2) Séries\n- [x] Limites\n  - [ ]  EDOs  '),
    ['Limites', 'Derivadas', 'Integrais', 'Séries', 'EDOs']);
  assert.deepEqual(tr.parseTopicList(' \n\n'), []);
});

test('buildCreateTrack validates each tab and builds the POST body', () => {
  const d = (over) => ({...tr.emptyTrackDraft(), ...over});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'goal', title: 'X'}), isGithubRepoUrl), {ok: false, error: 'goal'});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'goal', goal: 'ementa'}), isGithubRepoUrl), {ok: false, error: 'title'});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'goal', title: 'X', goal: 'a'.repeat(20001)}), isGithubRepoUrl), {ok: false, error: 'goalTooLong'});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'goal', title: '  Cálculo   II ', goal: ' ementa '}), isGithubRepoUrl),
    {ok: true, payload: {title: 'Cálculo II', source: 'goal', goal_description: 'ementa', activate: true}});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'manual', title: 'M', topics: '- a\n- b', activate: false}), isGithubRepoUrl),
    {ok: true, payload: {title: 'M', source: 'manual', items: ['a', 'b'], activate: false}});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'manual', title: 'M', topics: ''}), isGithubRepoUrl), {ok: false, error: 'topics'});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'repo', repoPath: '~/cursos/ml-101/'}), isGithubRepoUrl),
    {ok: true, payload: {title: 'ml-101', source: 'repo', repo_path: '~/cursos/ml-101/', activate: true}});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'repo'}), isGithubRepoUrl), {ok: false, error: 'repo'});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'github', githubUrl: 'not a url'}), isGithubRepoUrl), {ok: false, error: 'github'});
  assert.deepEqual(tr.buildCreateTrack(d({tab: 'github', githubUrl: 'https://github.com/owner/repo.git'}), isGithubRepoUrl),
    {ok: true, payload: {title: 'owner/repo', source: 'github', github_url: 'https://github.com/owner/repo.git', activate: true}});
  assert.equal(tr.canRegenerate(tr.decodeTrack(wire({source: 'manual'}))), false);
  assert.equal(tr.canRegenerate(tr.decodeTrack(wire({source: 'github'}))), true);
});

test('setup status decodes tracks and active_track_id; encodeConfig never sends them', () => {
  const s = decodeSetup({configured: true, config: {configured: true, language: 'pt-BR',
    track: {mode: 'free'}, active_track_id: 'trk-2', tracks: [wire({id: 'trk-1'}), wire({id: 'trk-2'})]}});
  assert.equal(s.config.active_track_id, 'trk-2');
  assert.deepEqual(s.config.tracks.map((t) => [t.id, t.active]), [['trk-1', false], ['trk-2', true]]);
  const legacy = decodeSetup({config: {track: {mode: 'free'}}});
  assert.deepEqual(legacy.config.tracks, []);
  const out = encodeConfig({...s.config});
  assert.equal('tracks' in out, false);
  assert.equal('active_track_id' in out, false);
});

test('tracks i18n has the same keys in pt-BR and en', () => {
  const keys = (o) => Object.keys(o).sort();
  const pt = i18n.tracksText('pt-BR');
  const en = i18n.tracksText('en');
  assert.deepEqual(keys(pt), keys(en));
  for (const k of ['sources', 'tabs', 'errors']) assert.deepEqual(keys(pt[k]), keys(en[k]));
  assert.equal(en.menuManage, 'Manage tracks');
  assert.equal(pt.tabs.goal, 'Objetivo ou ementa');
});
