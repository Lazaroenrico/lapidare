const {test} = require('node:test');
const assert = require('node:assert/strict');
const pl = require('../.test-build/plan-layout.js');

const n = (id, ...deps) => ({id, depends_on: deps});

test('longest-path layering puts every node below all its prerequisites', () => {
  const nodes = [n('goal', 'mid', 'a'), n('a'), n('b'), n('mid', 'a', 'b')];
  const {layers, layerOf, edges} = pl.layerDag(nodes);
  assert.deepEqual(layerOf, {a: 0, b: 0, mid: 1, goal: 2});
  assert.equal(layers.length, 3);
  assert.deepEqual([...layers[0]].sort(), ['a', 'b']);
  for (const [from, to] of edges) assert.ok(layerOf[from] < layerOf[to], `${from} above ${to}`);
});

test('unknown deps, self loops and duplicates are ignored; cycles do not hang', () => {
  const {layerOf, edges} = pl.layerDag([n('a', 'ghost', 'a'), n('b', 'a', 'a')]);
  assert.deepEqual(layerOf, {a: 0, b: 1});
  assert.deepEqual(edges, [['a', 'b']]);
  const cyc = pl.layerDag([n('x', 'y'), n('y', 'x')]);
  assert.equal(Object.keys(cyc.layerOf).length, 2);
});

test('barycenter ordering removes avoidable crossings', () => {
  // Input order forces a crossing: a→d, b→c with c listed before d.
  const nodes = [n('a'), n('b'), n('c', 'b'), n('d', 'a')];
  const naive = [['a', 'b'], ['c', 'd']];
  const edges = [['b', 'c'], ['a', 'd']];
  assert.equal(pl.countCrossings(naive, edges), 1);
  const {layers} = pl.layerDag(nodes);
  assert.equal(pl.countCrossings(layers, edges), 0);
});

test('layout is deterministic and keeps nodes inside the canvas', () => {
  const nodes = [n('r1'), n('r2'), n('s', 'r1', 'r2'), n('g', 's')];
  const a = pl.layoutDag(nodes);
  assert.deepEqual(pl.layoutDag(nodes), a);
  const {nodeWidth, nodeHeight} = pl.DEFAULT_LAYOUT;
  for (const id of ['r1', 'r2', 's', 'g']) {
    const p = a.positions[id];
    assert.ok(p.x >= 0 && p.x + nodeWidth <= a.width);
    assert.ok(p.y >= 0 && p.y + nodeHeight <= a.height);
  }
  assert.ok(a.positions.g.y > a.positions.s.y && a.positions.s.y > a.positions.r1.y);
  assert.equal(a.edges.length, 3);
  assert.match(a.edges[0].d, /^M[\d.]+,[\d.]+ C/);
  assert.deepEqual(pl.layoutDag([]).layers, []);
});

test('labels wrap into at most N lines with an ellipsis', () => {
  assert.deepEqual(pl.wrapLabel('Short', 10, 2), ['Short']);
  assert.deepEqual(pl.wrapLabel('one two three', 7, 2), ['one two', 'three']);
  const lines = pl.wrapLabel('alpha beta gamma delta epsilon', 10, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
  assert.ok(pl.wrapLabel('supercalifragilistic', 8, 2)[0].length <= 8);
});
