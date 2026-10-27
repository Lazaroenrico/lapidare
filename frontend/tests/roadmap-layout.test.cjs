const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const rl = require(`${OUT}/roadmap-layout.js`);
const gw = require(`${OUT}/graph-wire.js`);

const goalItems = () => {
  const stages = ['Fundamentos', 'Álgebra', 'Redes', 'Atenção', 'Projeto'];
  const out = [];
  let n = 0;
  stages.forEach((s, m) => {
    for (let k = 0; k < 2 + (m % 3); k++) {
      out.push({id: `track:g:i${n}`, track_id: 'g', track_title: 'Goal', order: n, depends_on: n ? [`track:g:i${n - 1}`] : [],
        module: {id: `stage:${s}`, title: s, order: m}, submodule: null});
      n++;
    }
  });
  return out;
};

const repoItems = () => {
  const out = [];
  let n = 0;
  for (let p = 1; p <= 4; p++) {
    for (let l = 1; l <= 4; l++) {
      for (let f = 0; f < 2; f++) {
        out.push({id: `track:r:${n}`, track_id: 'r', track_title: 'Repo', order: n, depends_on: [],
          module: {id: `path:phases/0${p}`, title: `Phase ${p}`, order: p - 1},
          submodule: {id: `path:phases/0${p}/0${l}`, title: `Lesson ${l}`}});
        n++;
      }
    }
  }
  return out;
};

const overlaps = (a, b, slack = 0) => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - slack;

test('layoutRoadmap groups track → module → submodule and places every item', () => {
  const items = [...goalItems(), ...repoItems()];
  const layout = rl.layoutRoadmap(items, {trackOrder: ['r', 'g']});
  assert.equal(layout.items.size, items.length);
  assert.deepEqual(layout.galaxies.map((g) => g.trackKey), ['r', 'g'], 'trackOrder decides the galaxy order');
  assert.equal(layout.modules.filter((m) => m.trackKey === 'g').length, 5);
  assert.equal(layout.modules.filter((m) => m.trackKey === 'r').length, 4);
  assert.equal(layout.submodules.length, 16, 'every two-step lesson becomes a sub-cluster');
  // Modules keep their order along the arm; items inside a module keep queue order.
  const g = layout.modules.filter((m) => m.trackKey === 'g');
  assert.deepEqual(g.map((m) => m.title), ['Fundamentos', 'Álgebra', 'Redes', 'Atenção', 'Projeto']);
  assert.deepEqual(g[0].itemIds, ['track:g:i0', 'track:g:i1']);
});

test('module discs never overlap and stars stay inside their module / submodule', () => {
  const many = [];
  for (let m = 0; m < 14; m++) {
    for (let k = 0; k < 1 + (m % 6); k++) {
      many.push({id: `x${m}-${k}`, track_id: 't', order: m * 10 + k, module: {id: `m${m}`, title: `M${m}`, order: m}, submodule: null});
    }
  }
  for (const items of [many, repoItems(), goalItems()]) {
    const layout = rl.layoutRoadmap(items);
    const mods = layout.modules;
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) assert.ok(!overlaps(mods[i], mods[j]), `${mods[i].title} × ${mods[j].title}`);
    }
    for (const m of mods) {
      for (const id of m.itemIds) {
        const p = layout.items.get(id);
        assert.ok(Math.hypot(p.x - m.x, p.y - m.y) <= m.r + 1e-6, `${id} inside ${m.title}`);
      }
    }
    for (const s of layout.submodules) {
      for (const id of s.itemIds) {
        const p = layout.items.get(id);
        assert.ok(Math.hypot(p.x - s.x, p.y - s.y) <= s.r + 1e-6);
        assert.equal(layout.submoduleOf.get(id), s.key);
      }
    }
  }
});

test('galaxies are stacked without overlapping and the layout is deterministic', () => {
  const items = [...repoItems(), ...goalItems()];
  const a = rl.layoutRoadmap(items, {trackOrder: ['r', 'g']});
  const b = rl.layoutRoadmap([...items].reverse(), {trackOrder: ['r', 'g']});
  assert.deepEqual([...a.items].sort(), [...b.items].sort(), 'input order does not move stars (queue order does)');
  const [g1, g2] = a.galaxies;
  assert.ok(g1.y1 < g2.y0, 'second galaxy starts below the first');
  // Status never takes part: the same grouping gives the same positions.
  const done = rl.layoutRoadmap(items.map((it) => ({...it, status: 'completed'})), {trackOrder: ['r', 'g']});
  assert.deepEqual([...done.items], [...a.items]);
});

test('offset and placement beside the graph', () => {
  const layout = rl.layoutRoadmap(goalItems());
  const off = rl.roadmapOffset({x0: -100, y0: -50, x1: 100, y1: 50}, layout);
  const moved = rl.offsetRoadmapLayout(layout, off.x, off.y);
  assert.ok(moved.bounds.x0 >= 100 + 100, 'starts to the right of the graph with a gap');
  assert.ok(Math.abs((moved.bounds.y0 + moved.bounds.y1) / 2) < 24, 'vertically centred on the graph');
  const first = layout.modules[0];
  const firstMoved = moved.modules[0];
  assert.equal(firstMoved.x - first.x, off.x);
  assert.equal(moved.galaxies[0].labelY - layout.galaxies[0].labelY, off.y);
  assert.equal(rl.layoutRoadmap([]).items.size, 0);
});

test('roadmapEdges: module path, in-module prerequisites and cross-module arcs', () => {
  const items = goalItems();
  items[4].depends_on = ['track:g:i0', 'track:g:i3'];
  const layout = rl.layoutRoadmap(items);
  const edges = rl.roadmapEdges(items, layout);
  const kind = (a, b) => edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))?.kind;
  assert.equal(kind('track:g:i0', 'track:g:i1'), 'path');
  assert.equal(kind('track:g:i0', 'track:g:i4'), 'cross');
  assert.equal(kind('track:g:i3', 'track:g:i4'), 'path', 'a prerequisite already drawn as the path is not doubled');
  assert.equal(edges.filter((e) => e.source === 'track:g:i1' && e.target === 'track:g:i2').length, 1);
});

test('decodeGraph keeps completed steps and decodes module / submodule', () => {
  const g = gw.decodeGraph({nodes: [], edges: [], roadmap: [
    {id: 'track:t:a', title: 'A', status: 'completed', track_id: 't', order: 0, kind: 'base', status_detail: 'nivelado',
      module: {id: 'path:phases/03', title: 'Deep learning', order: 0}, submodule: {id: 'path:phases/03/02', title: 'Attention'},
      source_ref: 'phases/03/02/docs/en.md'},
    {id: 'track:t:b', title: 'B', status: 'weird', track_id: 't'},
    {id: 'track:t:b', title: 'dup', status: 'pending', track_id: 't'},
  ]});
  assert.equal(g.roadmap.length, 2);
  assert.equal(g.roadmap[0].status, 'completed');
  assert.equal(g.roadmap[0].status_detail, 'nivelado');
  assert.equal(g.roadmap[0].kind, 'base');
  assert.deepEqual(g.roadmap[0].submodule, {id: 'path:phases/03/02', title: 'Attention'});
  assert.equal(g.roadmap[1].status, 'pending');
  assert.deepEqual(g.roadmap[1].module, {id: 'track', title: '', order: 0}, 'old servers fall back to one module');
  assert.equal(g.roadmap[1].order, 1, 'missing order = position in the track');
  assert.equal(g.roadmap[1].submodule, null);
});

test('wrapLabel keeps module labels to two short lines', () => {
  assert.deepEqual(rl.wrapLabel('Fundamentos matemáticos'), ['Fundamentos', 'matemáticos']);
  assert.deepEqual(rl.wrapLabel('Deep learning'), ['Deep learning']);
  assert.deepEqual(rl.wrapLabel('Uma etapa com um nome muito longo demais para caber'), ['Uma etapa com um', 'nome muito longo de…']);
  assert.deepEqual(rl.wrapLabel('  '), ['']);
});

test('alternate modules put their label below the disc', () => {
  const layout = rl.layoutRoadmap(goalItems());
  assert.deepEqual(layout.modules.map((m) => m.labelBelow), [false, true, false, true, false]);
});
