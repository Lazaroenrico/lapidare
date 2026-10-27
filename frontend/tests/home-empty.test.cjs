const {test} = require('node:test');
const assert = require('node:assert/strict');
const he = require('/tmp/learnharness-frontend-tests/home-empty.js');

const base = {graphLoaded: true, nodeCount: 0, trashCount: 0, activeTrackId: null, activeRoadmapSteps: 0};

test('empty state shows only after the first snapshot and with 0 nodes', () => {
  assert.equal(he.homeEmptyView({...base, graphLoaded: false}).show, false);
  assert.equal(he.homeEmptyView({...base, nodeCount: 1}).show, false);
  assert.deepEqual(he.homeEmptyView(base), {show: true, restoreCount: 0, suggestRoadmap: false});
});

test('restore link counts trash entries; hidden state carries nothing', () => {
  assert.equal(he.homeEmptyView({...base, trashCount: 3}).restoreCount, 3);
  assert.deepEqual(he.homeEmptyView({...base, nodeCount: 4, trashCount: 3, activeTrackId: 't', activeRoadmapSteps: 2}),
    {show: false, restoreCount: 0, suggestRoadmap: false});
});

test('roadmap is suggested only with an active track that has steps', () => {
  assert.equal(he.homeEmptyView({...base, activeTrackId: 't1', activeRoadmapSteps: 0}).suggestRoadmap, false);
  assert.equal(he.homeEmptyView({...base, activeTrackId: null, activeRoadmapSteps: 5}).suggestRoadmap, false);
  assert.equal(he.homeEmptyView({...base, activeTrackId: 't1', activeRoadmapSteps: 5}).suggestRoadmap, true);
  const roadmap = [{track_id: 't1'}, {track_id: 't2'}, {track_id: 't1'}, {track_id: null}];
  assert.equal(he.roadmapStepsFor(roadmap, 't1'), 2);
  assert.equal(he.roadmapStepsFor(roadmap, null), 0);
});

test('layout moves beside the roadmap only when it is drawn on a wide screen', () => {
  assert.equal(he.homeEmptyLayout(false, true), 'centered');
  assert.equal(he.homeEmptyLayout(true, false), 'centered');
  assert.equal(he.homeEmptyLayout(true, true), 'beside-roadmap');
  const view = he.homeEmptyView({...base, activeTrackId: 't1', activeRoadmapSteps: 2});
  assert.equal(he.showRoadmapSuggestion(view, false), true);
  assert.equal(he.showRoadmapSuggestion(view, true), false);
  assert.equal(he.showRoadmapSuggestion(he.homeEmptyView(base), false), false);
});

test('auto roadmap fires once per track and tolerates bad storage', () => {
  const view = he.homeEmptyView({...base, activeTrackId: 't1', activeRoadmapSteps: 2});
  assert.deepEqual(he.decodeAutoRoadmap(null), []);
  assert.deepEqual(he.decodeAutoRoadmap('{bad'), []);
  assert.deepEqual(he.decodeAutoRoadmap('{"a":1}'), []);
  assert.deepEqual(he.decodeAutoRoadmap('["t0", 3, ""]'), ['t0']);
  assert.equal(he.shouldAutoRoadmap(view, 't1', []), true);
  assert.equal(he.shouldAutoRoadmap(view, 't1', [], false), false);
  const stored = he.rememberAutoRoadmap(['t0', 't1'], 't1');
  assert.deepEqual(he.decodeAutoRoadmap(stored), ['t0', 't1']);
  assert.equal(he.shouldAutoRoadmap(view, 't1', he.decodeAutoRoadmap(stored)), false);
  const filled = he.homeEmptyView({...base, nodeCount: 1, activeTrackId: 't2', activeRoadmapSteps: 1});
  assert.equal(he.shouldAutoRoadmap(filled, 't2', []), false);
  const many = Array.from({length: 60}, (_, i) => `t${i}`);
  assert.equal(he.decodeAutoRoadmap(he.rememberAutoRoadmap(many, 'new')).length, 50);
});

test('constellation is deterministic and stays inside its box', () => {
  const a = he.buildConstellation();
  const b = he.buildConstellation();
  assert.deepEqual(a, b);
  assert.equal(a.stars.length, 22);
  for (const s of a.stars) {
    assert.ok(s.x >= 0 && s.x <= a.width && s.y >= 0 && s.y <= a.height);
    assert.ok(s.alpha > 0 && s.alpha <= 1);
  }
  for (const [i, j] of a.links) assert.ok(a.stars[i] && a.stars[j]);
  assert.notDeepEqual(he.buildConstellation(7), a);
});

test('strings exist in PT-BR and EN', () => {
  assert.match(he.homeEmptyText('pt-BR').lead, /mapa de conhecimento aparece aqui/);
  assert.match(he.homeEmptyText('en').lead, /knowledge map/);
  assert.equal(he.homeEmptyText('pt-BR').restore(2), 'Restaurar sessões (2)');
  assert.equal(he.homeEmptyText('en').restore(2), 'Restore sessions (2)');
  for (const loc of ['pt-BR', 'en']) {
    const t = he.homeEmptyText(loc);
    for (const k of ['startTopic', 'importNotes', 'createTrack', 'roadmapSuggest']) assert.ok(t[k].length > 0);
  }
});
