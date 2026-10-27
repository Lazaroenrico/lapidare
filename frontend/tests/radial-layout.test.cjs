// Radial "flower" layout: depth rings, sectors per cluster, outer band, forces.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const rl = require(`${OUT}/radial-layout.js`);

const arc = (premise, conclusion) => ({premise, conclusion});
const P = {ringRadius: 100, depthSpacing: 50};

test('depth = longest derivation path from a foundation (premises inside, conclusions outside)', () => {
  const d = rl.inferenceDepths(['a', 'b', 'c', 'd', 'e'], [arc('a', 'c'), arc('b', 'c'), arc('c', 'd'), arc('a', 'd'), arc('x', 'e')]);
  assert.deepEqual(Object.fromEntries(d), {a: 0, b: 0, c: 1, d: 2, e: 0}, 'unknown ids and self loops are ignored');
});

test('cycles never hang and stay finite and deterministic', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const arcs = [arc('a', 'b'), arc('b', 'c'), arc('c', 'a'), arc('c', 'd'), arc('d', 'd')];
  const d1 = rl.inferenceDepths(ids, arcs);
  const d2 = rl.inferenceDepths([...ids].reverse(), [...arcs].reverse());
  assert.deepEqual(Object.fromEntries(d1), Object.fromEntries(d2));
  for (const v of d1.values()) assert.ok(Number.isFinite(v) && v >= 0 && v <= ids.length);
  assert.ok(d1.get('d') > d1.get('c'), 'a conclusion of the cycle sits outside it');
});

test('sectors tile the circle clockwise from the top, sized sub-linearly, in the given order', () => {
  const s = rl.allocateSectors(new Map([['big', 40], ['small', 10], ['mid', 20]]), ['small', 'big', 'mid'], 0.05);
  const list = [...s.values()].sort((a, b) => a.index - b.index);
  assert.deepEqual(list.map((x) => x.cluster), ['small', 'big', 'mid']);
  assert.ok(Math.abs(list[0].start - (-Math.PI / 2 + 0.025)) < 1e-9, 'first sector starts at the top');
  const width = (x) => x.end - x.start;
  const total = list.reduce((sum, x) => sum + width(x), 0) + 0.05 * 3;
  assert.ok(Math.abs(total - Math.PI * 2) < 1e-9);
  assert.ok(width(s.get('big')) > width(s.get('mid')) && width(s.get('mid')) > width(s.get('small')));
  assert.ok(width(s.get('big')) / width(s.get('small')) < 4, 'size^0.75, not linear');
  for (let i = 1; i < list.length; i++) assert.ok(list[i].start >= list[i - 1].end - 1e-9, 'no overlap');
  const one = rl.allocateSectors(new Map([['only', 3]]));
  assert.ok(Math.abs(one.get('only').end - one.get('only').start - Math.PI * 2) < 1e-9);
});

function sampleGraph() {
  const nodes = [
    {id: 'a1', cluster: 'A'}, {id: 'a2', cluster: 'A'}, {id: 'a3', cluster: 'A'}, {id: 'a4', cluster: 'A'}, {id: 'aiso', cluster: 'A'},
    {id: 'b1', cluster: 'B'}, {id: 'b2', cluster: 'B'}, {id: 'b3', cluster: 'B'},
    {id: 'loose'},
  ];
  const arcs = [arc('a1', 'a3'), arc('a2', 'a3'), arc('a3', 'a4'), arc('b1', 'b2'), arc('b2', 'b3')];
  const junctions = [{id: 'junction:j', premises: ['a1', 'a2'], conclusion: 'a3', cluster: 'A'}];
  return {nodes, arcs, junctions};
}

test('plan: rings by depth, junction halfway, isolated nodes on the outer band inside their sector', () => {
  const {nodes, arcs, junctions} = sampleGraph();
  const plan = rl.planRadial(nodes, junctions, arcs, {...P, clusterOrder: ['A', 'B']});
  assert.equal(plan.maxDepth, 2);
  assert.equal(plan.radius.get('a1'), 100);
  assert.equal(plan.radius.get('a3'), 150);
  assert.equal(plan.radius.get('a4'), 200);
  assert.equal(plan.depth.get('junction:j'), 0.5, 'between the deepest premise and the conclusion');
  assert.equal(plan.radius.get('junction:j'), 125);
  assert.deepEqual([...plan.isolated].sort(), ['aiso', 'loose']);
  assert.ok(plan.peripheryRadius > plan.radius.get('a4'));
  for (const id of plan.isolated) assert.ok(plan.radius.get(id) > plan.radius.get('a4'), `${id} beyond the deepest ring`);
  // Every node's seed angle lies in its own sector.
  for (const n of nodes) {
    const sec = plan.sectors.get(n.cluster ?? '');
    const a = plan.angle.get(n.id);
    assert.ok(a >= sec.start - 1e-9 && a <= sec.end + 1e-9, `${n.id} inside sector ${sec.cluster}`);
  }
  assert.equal(plan.clusterOf.get('junction:j'), 'A');
  assert.equal(plan.clusterOf.get('loose'), '', 'no cluster → its own "" sector');
});

test('plan and seeds are deterministic; adding a node keeps others on their rings and sector order', () => {
  const {nodes, arcs, junctions} = sampleGraph();
  const p1 = rl.planRadial(nodes, junctions, arcs, {...P, clusterOrder: ['A', 'B']});
  const p2 = rl.planRadial(nodes, junctions, arcs, {...P, clusterOrder: ['A', 'B']});
  for (const n of nodes) assert.deepEqual(rl.seedPosition(p1, n.id), rl.seedPosition(p2, n.id));
  const grown = rl.planRadial([...nodes, {id: 'b4', cluster: 'B'}], junctions, [...arcs, arc('b3', 'b4')], {...P, clusterOrder: ['A', 'B']});
  for (const id of ['a1', 'a3', 'a4', 'b1', 'b2', 'b3']) assert.equal(grown.radius.get(id), p1.radius.get(id), `${id} ring unchanged`);
  assert.equal(grown.sectors.get('A').index, 0);
  assert.equal(grown.sectors.get('B').index, 1);
  assert.equal(rl.seedPosition(p1, 'nope'), null);
});

test('forces pull a body toward its ring and back inside its sector; fixed bodies are untouched', () => {
  const {nodes, arcs, junctions} = sampleGraph();
  const plan = rl.planRadial(nodes, junctions, arcs, {...P, clusterOrder: ['A', 'B']});
  const sec = plan.sectors.get('A');
  // a4 (target r=200) placed at r=400 on the far side of the circle from its sector.
  const away = sec.mid + Math.PI;
  const body = {id: 'a4', x: Math.cos(away) * 400, y: Math.sin(away) * 400, vx: 0, vy: 0, fixed: false};
  const pinned = {id: 'a1', x: 999, y: 999, vx: 0, vy: 0, fixed: true};
  for (let i = 0; i < 400; i++) {
    rl.applyRadialForces([body, pinned], plan, {depthStrength: 0.1, clusterPull: 0.02, centerPull: 0}, 1);
    body.x += body.vx; body.y += body.vy; body.vx *= 0.6; body.vy *= 0.6;
  }
  assert.ok(Math.abs(Math.hypot(body.x, body.y) - 200) < 5, 'settles on its depth ring');
  const theta = Math.atan2(body.y, body.x);
  assert.ok(Math.abs(rl.angleDelta(theta, sec.mid)) <= (sec.end - sec.start) / 2 + 0.02, 'back inside its sector');
  assert.deepEqual([pinned.x, pinned.y, pinned.vx, pinned.vy], [999, 999, 0, 0]);
});

test('unitHash is stable and in [0, 1)', () => {
  const v = rl.unitHash('node-1');
  assert.equal(v, rl.unitHash('node-1'));
  assert.notEqual(v, rl.unitHash('node-1', 1));
  for (const s of ['', 'a', 'b', 'longer id']) assert.ok(rl.unitHash(s) >= 0 && rl.unitHash(s) < 1);
});
