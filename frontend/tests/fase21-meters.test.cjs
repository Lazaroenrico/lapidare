// Fase 21: coverage ring, usage popover formatting, Home counts, graph-settings `rendering`, agent settings wire.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = require('node:path').join(__dirname, '..', '.test-build');
const ring = require(`${OUT}/coverage-ring.js`);
const usage = require(`${OUT}/usage.js`);
const gs = require(`${OUT}/graph-settings.js`);
const hc = require(`${OUT}/home-counts.js`);
const sw = require(`${OUT}/settings-wire.js`);

test('ringState hides without coverage or when extraction is disabled', () => {
  assert.equal(ring.ringState(null).visible, false);
  assert.equal(ring.ringState(undefined).visible, false);
  assert.equal(ring.ringState({uncovered_tokens: 10, chunk_tokens: 100, extracting: false, enabled: false}).visible, false);
});

test('ringState fraction is uncovered / chunk, capped at 1, tolerant of chunk 0', () => {
  const base = {chunk_tokens: 4000, extracting: false, enabled: true};
  assert.equal(ring.ringState({...base, uncovered_tokens: 1000}).fraction, 0.25);
  assert.equal(ring.ringState({...base, uncovered_tokens: 9000}).fraction, 1);
  assert.equal(ring.ringState({...base, chunk_tokens: 0, uncovered_tokens: 5}).fraction, 0);
});

test('ringState tooltip and pulse follow extraction, in both locales', () => {
  const idle = ring.ringState({uncovered_tokens: 1000, chunk_tokens: 4000, extracting: false, enabled: true}, 'pt-BR');
  assert.equal(idle.pulsing, false);
  assert.equal(idle.tooltip, '1k de 4k tokens até a próxima extração');
  const busy = ring.ringState({uncovered_tokens: 1000, chunk_tokens: 4000, extracting: true, enabled: true}, 'en');
  assert.equal(busy.pulsing, true);
  assert.equal(busy.tooltip, 'Extracting to the graph…');
  assert.equal(ring.ringState({uncovered_tokens: 0, chunk_tokens: 4000, extracting: true, enabled: true}, 'pt-BR').tooltip, 'Extraindo para o grafo…');
});

test('decodeSessionUsage tolerates old payloads without the Fase 21 fields', () => {
  const u = usage.decodeSessionUsage({input_tokens: 10, output_tokens: 5, turns: 2});
  assert.equal(u.context_tokens, null);
  assert.equal(u.context_limit, 0);
  assert.equal(u.limit_kind, 'compaction');
  assert.equal(u.last_turn, null);
  assert.equal(usage.decodeSessionUsage(null), null);
  assert.equal(usage.decodeCoverage('x'), null);
});

test('contextMeter: 42k / 150k, "?" for null tokens, window kind, capped fill', () => {
  const u = usage.decodeSessionUsage({input_tokens: 1, context_tokens: 42000, context_limit: 150000, limit_kind: 'compaction'});
  const m = usage.contextMeter(u, 'en');
  assert.deepEqual([m.used, m.limit, m.kind, m.known], ['42k', '150k', 'compaction', true]);
  assert.equal(m.fraction, 0.28);
  const none = usage.contextMeter({...u, context_tokens: null}, 'en');
  assert.deepEqual([none.used, none.fraction], ['?', 0]);
  const win = usage.contextMeter({...u, context_tokens: 300000, limit_kind: 'window'});
  assert.equal(win.kind, 'window');
  assert.equal(win.fraction, 1);
  assert.equal(usage.contextMeter({...u, context_limit: 0}).limit, '?');
});

test('lastTurnRows lists cache only when reported', () => {
  assert.deepEqual(usage.lastTurnRows(null), []);
  const turn = {input_tokens: 1200, output_tokens: 300, thinking_tokens: 0, cached_tokens: null};
  assert.deepEqual(usage.lastTurnRows(turn, 'en').map((r) => r.key), ['input', 'output', 'thinking']);
  const rows = usage.lastTurnRows({...turn, cached_tokens: 800}, 'en');
  assert.deepEqual(rows.map((r) => r.key), ['input', 'output', 'thinking', 'cached']);
  assert.equal(rows[0].value, '1.2k');
});

test('graph settings: rendering defaults to on, sanitizes, and old storage keeps the other options', () => {
  assert.equal(gs.DEFAULT_GRAPH_SETTINGS.rendering, 1);
  assert.equal(gs.clampSetting('rendering', false), 0);
  assert.equal(gs.clampSetting('rendering', 0), 0);
  assert.equal(gs.clampSetting('rendering', 'abc'), 1);
  assert.equal(gs.clampSetting('rendering', 7), 1);
  const old = gs.parseGraphSettings(JSON.stringify({nodeSize: 5, edgeWidth: 2}));
  assert.equal(old.rendering, 1);
  assert.equal(old.nodeSize, 5);
  const off = gs.parseGraphSettings(gs.serializeGraphSettings(gs.withSetting(old, 'rendering', 0)));
  assert.equal(off.rendering, 0);
  assert.equal(off.nodeSize, 5);
  assert.equal(gs.isDefaultSettings(off), false);
});

test('homeCounts counts nodes, chains, session clusters and distinct live sources', () => {
  const node = (id, sources, ghost = false) => ({id, ghost, sources});
  const c = hc.homeCounts({
    nodes: [
      node('a', [{source_id: 's1', deleted: false}, {source_id: 's2', deleted: true}]),
      node('b', [{source_id: 's1', deleted: false}]),
    ],
    chains: [{id: 'c1'}],
    clusters: [{kind: 'session'}, {kind: 'notes'}, {kind: 'session'}],
  });
  assert.deepEqual(c, {nodes: 2, chains: 1, sessions: 2, sources: 1});
});

test('agent settings wire carries extraction_enabled (default on, strict boolean)', () => {
  assert.equal(sw.decodeAgentSettings({}).extraction_enabled, true);
  assert.equal(sw.decodeAgentSettings({extraction_enabled: false}).extraction_enabled, false);
  assert.equal(sw.decodeAgentSettings({extraction_enabled: 'no'}).extraction_enabled, true);
});
