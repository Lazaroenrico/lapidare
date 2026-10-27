// Constellation look: junction wiring for multi-premise chains and the small-scale settings ranges.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const gw = require(`${OUT}/graph-wire.js`);
const gs = require(`${OUT}/graph-settings.js`);

const node = (id, extra = {}) => ({id, name: id.toUpperCase(), statement: '', summary: '', file_path: '', depends_on: [],
  aliases: [], sessions: [], cluster: 's1', ...extra});
const chain = (id, premises, conclusion) => ({id, premises, conclusion, premise_names: premises, conclusion_name: conclusion, expression: ''});

test('multi-premise chains meet at one junction; single-premise chains are direct lines', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d', {cluster: 's2'}), node('e')];
  const chains = [chain('c1', ['a', 'b'], 'd'), chain('c2', ['c'], 'e')];
  const edges = [{source: 'a', target: 'd', kind: 'chain'}, {source: 'b', target: 'd', kind: 'chain'}, {source: 'c', target: 'e', kind: 'chain'}];
  const w = gw.buildConstellation(nodes, edges, chains);
  assert.deepEqual(w.junctions, [{id: 'junction:c1', chainId: 'c1', premises: ['a', 'b'], conclusion: 'd', cluster: 's2'}]);
  assert.deepEqual(w.links, [
    {source: 'a', target: 'junction:c1', kind: 'premise'},
    {source: 'b', target: 'junction:c1', kind: 'premise'},
    {source: 'junction:c1', target: 'd', kind: 'conclusion'},
    {source: 'c', target: 'e', kind: 'direct'},
  ], 'premise→conclusion edges routed through the junction are not drawn twice');
  assert.ok(gw.isJunctionId('junction:c1'));
  assert.ok(!gw.isJunctionId('a'));
  assert.ok(!w.junctions.some((j) => nodes.some((n) => n.id === j.id)), 'junctions are virtual, never real nodes');
});

test('junction wiring resolves names/aliases, drops unknown or self premises, dedupes ids and legacy depends_on', () => {
  const nodes = [node('a', {aliases: ['alpha']}), node('b'), node('c', {depends_on: ['B']}), node('x')];
  const chains = [
    chain('k', ['alpha', 'B', 'ghost', 'c'], 'c'), // → premises a, b (ghost unknown, c is the conclusion)
    chain('k', ['a', 'x'], 'c'), // same chain id → unique junction id
    chain('solo', ['ghost', 'x'], 'b'), // only one resolvable premise → direct
    chain('dead', ['a', 'b'], 'missing'), // unknown conclusion → nothing
  ];
  const w = gw.buildConstellation(nodes, [{source: 'a', target: 'nope'}], chains);
  assert.deepEqual(w.junctions.map((j) => [j.id, j.premises]), [['junction:k', ['a', 'b']], ['junction:k#1', ['a', 'x']]]);
  const direct = w.links.filter((l) => l.kind === 'direct').map((l) => `${l.source}>${l.target}`);
  assert.deepEqual(direct, ['x>b'], 'b→c from depends_on is already routed through junction:k');
  assert.equal(w.links.filter((l) => l.kind === 'conclusion').length, 2);
});

test('no chains → server edges and depends_on become direct lines once', () => {
  const nodes = [node('a'), node('b', {depends_on: ['a']})];
  const w = gw.buildConstellation(nodes, [{source: 'a', target: 'b', kind: 'dependency'}], []);
  assert.deepEqual(w, {junctions: [], links: [{source: 'a', target: 'b', kind: 'direct'}]});
});

test('constellation defaults are small and old stored settings are clamped into the new ranges', () => {
  const d = gs.DEFAULT_GRAPH_SETTINGS;
  assert.equal(d.nodeSize, 2.5);
  assert.equal(d.edgeWidth, 0.75);
  assert.equal(d.labelSize, 9.5);
  assert.equal(d.linkDistance, 45);
  const R = gs.GRAPH_SETTING_RANGES;
  assert.deepEqual([R.nodeSize.min, R.nodeSize.max], [1, 12]);
  assert.deepEqual([R.edgeWidth.min, R.edgeWidth.max], [0.25, 3]);
  assert.deepEqual([R.labelSize.min, R.labelSize.max], [7, 16]);
  assert.deepEqual([R.linkDistance.min, R.linkDistance.max], [15, 200]);
  // Settings saved with the previous big-circle look.
  const old = gs.parseGraphSettings(JSON.stringify({nodeSize: 14, edgeWidth: 4, labelSize: 18, linkDistance: 300, repulsion: 8000}));
  assert.equal(old.nodeSize, 12);
  assert.equal(old.edgeWidth, 3);
  assert.equal(old.labelSize, 16);
  assert.equal(old.linkDistance, 200);
  assert.equal(old.repulsion, R.repulsion.max);
  assert.equal(gs.withSetting(d, 'nodeSize', 0.2).nodeSize, 1);
});
