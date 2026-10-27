const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const gw = require(`${OUT}/graph-wire.js`);
const sel = require(`${OUT}/graph-selection.js`);
const gs = require(`${OUT}/graph-settings.js`);
const usage = require(`${OUT}/usage.js`);
const mc = require(`${OUT}/model-choice.js`);

test('decodeGraph reads the Fase 8B snapshot (sessions, clusters, roadmap, positions)', () => {
  const g = gw.decodeGraph({
    nodes: [
      {id: 'n_a', name: 'A', title: 'A', statement: 'A is true', aliases: ['alpha'], cluster: 's1',
        sessions: [{session_id: 's1', title: 'Attention', message_id: 'm1'}], vault_rel_path: 'Conceitos/A.md', x: 10, y: 20, ghost: false},
      {id: 'n_b', name: 'B', statement: 'B', cluster: 's1', sessions: []},
      {id: 'n_c', name: 'C', statement: 'C', cluster: 's1'},
      {id: 'track:x', name: 'ghost', ghost: true},
    ],
    chains: [{id: 'arg_1', premises: ['n_a', 'n_b'], conclusion: 'n_c', expression: 'A ∧ B ⟹ C', session_id: 's1'}],
    edges: [{source: 'n_a', target: 'n_c', kind: 'chain'}],
    clusters: [{id: 's1', label: 'Attention', kind: 'session', size: 3}],
    roadmap: [
      {id: 'track:i1', title: 'Lesson 1', status: 'completed', linked_node_ids: []},
      {id: 'track:i2', title: 'Lesson 2', status: 'pending', linked_node_ids: ['n_a'], depends_on: ['track:i1']},
    ],
  });
  assert.equal(g.nodes.length, 3, 'ghost rows never become real nodes');
  assert.equal(g.nodes[0].file_path, 'Conceitos/A.md');
  assert.equal(g.nodes[0].summary, 'A is true');
  assert.equal(g.nodes[0].x, 10);
  assert.equal(g.nodes[1].x, undefined);
  assert.deepEqual(g.chains[0].premise_names, ['A', 'B']);
  assert.equal(g.edges.length, 2, 'derived chain edges are deduplicated against server edges');
  assert.equal(g.clusters[0].label, 'Attention');
  assert.deepEqual(g.roadmap.map(r => [r.id, r.status]), [['track:i1', 'completed'], ['track:i2', 'pending']]);
  assert.equal(gw.trackItemIdOf('track:i2'), 'i2');
  assert.equal(gw.sessionMessageHref(g.nodes[0].sessions[0]), '/chat/s1#message-m1');
});

test('decodeGraph keeps the legacy shape working (title/summary, chains by name, cluster fallback)', () => {
  const g = gw.decodeGraph({
    nodes: [
      {id: 'c1', title: 'Softmax', summary: 'normalizes', cluster: 'legacy', file_path: 'Conceitos/Softmax.md', status: 'sólido'},
      {id: 'c2', name: 'Attention', summary: 'weights', cluster: 'legacy'},
    ],
    chains: [{id: 'ch', premises: ['softmax'], conclusion: 'Attention', formula: 'S ⟹ A'}],
    edges: [],
  });
  assert.equal(g.nodes[0].name, 'Softmax');
  assert.equal(g.nodes[0].status, 'sólido');
  assert.deepEqual(g.chains[0].premises, ['c1'], 'names resolve to ids case-insensitively');
  assert.equal(g.chains[0].conclusion, 'c2');
  assert.equal(g.chains[0].expression, 'S ⟹ A');
  assert.deepEqual(g.edges, [{source: 'c1', target: 'c2', kind: 'chain'}]);
  assert.deepEqual(g.clusters, [{id: 'legacy', label: 'legacy', kind: 'legacy', size: 2}]);
  assert.deepEqual(g.roadmap, []);
  assert.deepEqual(gw.decodeGraph(null).nodes, []);
});

test('selection set ops keep order, uniqueness and the 64-id cap', () => {
  let s = [];
  s = sel.toggleId(s, 'a');
  s = sel.addIds(s, ['b', 'a', 'c']);
  assert.deepEqual(s, ['a', 'b', 'c']);
  s = sel.toggleId(s, 'b');
  assert.deepEqual(s, ['a', 'c']);
  const same = sel.pruneSelection(s, new Set(['a', 'c']));
  assert.equal(same, s, 'unchanged selection keeps its reference');
  assert.deepEqual(sel.pruneSelection(s, new Set(['c'])), ['c']);
  const many = Array.from({length: 80}, (_, i) => `n${i}`);
  assert.equal(sel.graphContextPayload(many).length, sel.MAX_GRAPH_CONTEXT);
});

test('chain checkbox selects all its nodes, and a fully selected chain is removed', () => {
  const chain = {premises: ['a', 'b'], conclusion: 'c'};
  assert.equal(sel.chainSelectionState([], chain), 'none');
  assert.equal(sel.chainSelectionState(['a'], chain), 'some');
  const all = sel.toggleChain(['x', 'a'], chain);
  assert.deepEqual(all, ['x', 'a', 'b', 'c']);
  assert.equal(sel.chainSelectionState(all, chain), 'all');
  assert.deepEqual(sel.toggleChain(all, chain), ['x']);
  // Unresolved legacy premises are ignored when validIds is given.
  assert.deepEqual(sel.toggleChain([], {premises: ['raw name', 'a'], conclusion: 'c'}, new Set(['a', 'c'])), ['a', 'c']);
});

test('graph settings clamp, default and survive corrupt storage', () => {
  assert.deepEqual(gs.parseGraphSettings(null), gs.DEFAULT_GRAPH_SETTINGS);
  assert.deepEqual(gs.parseGraphSettings('{not json'), gs.DEFAULT_GRAPH_SETTINGS);
  const s = gs.parseGraphSettings(JSON.stringify({nodeSize: 999, repulsion: -5, edgeWidth: '2', bogus: 1, labelZoom: 'x'}));
  assert.equal(s.nodeSize, gs.GRAPH_SETTING_RANGES.nodeSize.max);
  assert.equal(s.repulsion, gs.GRAPH_SETTING_RANGES.repulsion.min);
  assert.equal(s.edgeWidth, 2);
  assert.equal(s.labelZoom, gs.GRAPH_SETTING_RANGES.labelZoom.default);
  assert.equal('bogus' in s, false);
  assert.equal(gs.withSetting(s, 'nodeSize', 1).nodeSize, gs.GRAPH_SETTING_RANGES.nodeSize.min);
  assert.equal(gs.isDefaultSettings(gs.parseGraphSettings(gs.serializeGraphSettings(gs.DEFAULT_GRAPH_SETTINGS))), true);
  for (const k of gs.GRAPH_SETTING_KEYS) {
    const r = gs.GRAPH_SETTING_RANGES[k];
    assert.ok(r.min <= r.default && r.default <= r.max, `${k} default inside range`);
  }
});

test('usage report decodes, sorts top sessions and formats compact counts', () => {
  const r = usage.decodeUsageReport({
    today: {input_tokens: 10000, output_tokens: 2000, thinking_tokens: 400, turns: 3},
    total: {total_tokens: 1250000},
    by_session: [{session_id: 'a', title: 'A', input_tokens: 5}, {session_id: 'b', usage: {output_tokens: 50}}, {title: 'no id'}],
  });
  assert.equal(r.today.total_tokens, 12400);
  assert.equal(r.total.total_tokens, 1250000);
  assert.deepEqual(r.by_session.map(s => s.session_id), ['b', 'a']);
  assert.equal(r.by_session[0].title, 'b');
  assert.equal(usage.formatTokens(12400, 'pt-BR'), '12,4k');
  assert.equal(usage.formatTokens(12400, 'en'), '12.4k');
  assert.equal(usage.formatTokens(980), '980');
  assert.equal(usage.formatTokens(250000), '250k');
  assert.equal(usage.formatTokens(1250000), '1,3M');
  assert.equal(usage.formatTokens(3000), '3k');
  assert.equal(usage.decodeUsageReport('nope'), null);
  assert.equal(usage.decodeUsageCounters(undefined), null);
});

test('model ids with an effort suffix pin the effort; payload omits it', () => {
  assert.equal(mc.pinnedEffort('gemini-3.8-flash-low'), 'low');
  assert.equal(mc.pinnedEffort('gemini-4-argon-xhigh'), 'xhigh');
  assert.equal(mc.pinnedEffort('gemini-3.8-flash'), null);
  assert.equal(mc.pinnedEffort('auto'), null);
  assert.deepEqual(mc.modelChoicePayload({model: 'gemini-x-max', effort: 'high'}), {model_id: 'gemini-x-max'});
  assert.deepEqual(mc.modelChoicePayload({model: 'gemini-x', effort: 'high'}), {model_id: 'gemini-x', effort: 'high'});
  assert.equal(mc.differsFromSlot({model: 'auto', effort: 'medium'}, {model: 'auto', effort: 'medium'}), false);
  assert.equal(mc.differsFromSlot({model: 'auto', effort: 'high'}, {model: 'auto', effort: 'medium'}), true);
  assert.equal(mc.differsFromSlot({model: 'm-low', effort: 'high'}, {model: 'm-low', effort: 'medium'}), false);
  assert.deepEqual(mc.decodeSlotOverride({engine: 'gemini_cli', model_id: 'g', effort: 'low'}), {engine: 'gemini', model: 'g', effort: 'low'});
  assert.equal(mc.decodeSlotOverride(null), null);
});

test('session decode carries slot_override, usage and graph_context', () => {
  const sw = require(`${OUT}/session-wire.js`);
  const s = sw.decodeSession({id: 's', messages: [], slot_override: {engine: 'agy', model_id: 'm', effort: 'high'},
    usage: {input_tokens: 3, output_tokens: 4, turns: 1}, graph_context: ['n_a', 1]});
  assert.equal(s.slot_override.model, 'm');
  const eff = sw.decodeSession({id: 'e', messages: [], slot_override: null, effective_slot: {engine: 'genai_sdk', model_id: 'x-low', effort: 'medium'}});
  assert.deepEqual(eff.effective_slot, {engine: 'sdk', model: 'x-low', effort: 'medium'});
  assert.equal(eff.slot_override, null);
  assert.equal(s.usage.total_tokens, 7);
  assert.deepEqual(s.graph_context, ['n_a']);
  const old = sw.decodeSession({id: 'o', messages: []});
  assert.equal(old.slot_override, null);
  assert.equal(old.usage, null);
});
