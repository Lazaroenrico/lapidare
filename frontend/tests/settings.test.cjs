// Fase 13: appearance clamp/parse, prompt grouping, agent settings wire, key capture, command targets.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const ap = require('/tmp/learnharness-frontend-tests/appearance.js');
const sw = require('/tmp/learnharness-frontend-tests/settings-wire.js');
const kc = require('/tmp/learnharness-frontend-tests/key-capture.js');
const kb = require('/tmp/learnharness-frontend-tests/keyboard.js');
const ce = require('/tmp/learnharness-frontend-tests/command-events.js');

test('prose size clamps to 14–20 integers and falls back to 16', () => {
  assert.equal(ap.clampProseSize(13), 14);
  assert.equal(ap.clampProseSize(25), 20);
  assert.equal(ap.clampProseSize(17.6), 18);
  assert.equal(ap.clampProseSize('19'), 19);
  assert.equal(ap.clampProseSize('abc'), 16);
  assert.equal(ap.clampProseSize(null), 16);
  assert.equal(ap.clampProseSize(Infinity), 16);
});

test('appearance parse tolerates null, corrupt and partial JSON', () => {
  assert.deepEqual(ap.parseAppearance(null), {proseSize: 16, serifTitles: true});
  assert.deepEqual(ap.parseAppearance('{oops'), {proseSize: 16, serifTitles: true});
  assert.deepEqual(ap.parseAppearance('[1,2]'), {proseSize: 16, serifTitles: true});
  assert.deepEqual(ap.parseAppearance('{"proseSize": 30}'), {proseSize: 20, serifTitles: true});
  assert.deepEqual(ap.parseAppearance('{"serifTitles": false, "x": 1}'), {proseSize: 16, serifTitles: false});
  assert.deepEqual(ap.parseAppearance('{"serifTitles": "no"}'), {proseSize: 16, serifTitles: true});
  const round = ap.parseAppearance(ap.serializeAppearance({proseSize: 18, serifTitles: false}));
  assert.deepEqual(round, {proseSize: 18, serifTitles: false});
});

test('appearance maps to CSS variables, defaults remove the overrides', () => {
  assert.deepEqual(ap.appearanceVars(ap.DEFAULT_APPEARANCE), {'--prose-size': null, '--font-title': null});
  assert.deepEqual(ap.appearanceVars({proseSize: 18, serifTitles: false}), {
    '--prose-size': '18px',
    '--font-title': 'var(--font-prose)',
  });
  assert.ok(ap.isDefaultAppearance({proseSize: 16, serifTitles: true}));
  assert.ok(!ap.isDefaultAppearance({proseSize: 15, serifTitles: true}));
});

test('prompts group by path in the fixed order and keep server order inside a group', () => {
  const seg = (path) => ({path, source: 's', override: null, enabled: false});
  const groups = sw.groupPrompts([
    seg('teacher/10-plan.md'), seg('shared/20-voice.md'), seg('handoff.md'), seg('prober/10-probe.md'),
    seg('practice/10-opening.md'), seg('shared/10-identity.md'), seg('teacher/05-intro.md'), seg('weird.md'),
  ]);
  assert.deepEqual(groups.map((g) => g.id), ['shared', 'prober', 'teacher', 'practice', 'handoff', 'other']);
  assert.deepEqual(groups[0].segments.map((s) => s.path), ['shared/20-voice.md', 'shared/10-identity.md']);
  assert.deepEqual(groups[2].segments.map((s) => s.path), ['teacher/10-plan.md', 'teacher/05-intro.md']);
  assert.deepEqual(sw.groupPrompts([seg('handoff.md')]).map((g) => g.id), ['handoff']);
  assert.deepEqual(sw.groupPrompts([]), []);
});

test('prompt helpers: decode, URL keeps slashes, label drops prefix', () => {
  const decoded = sw.decodePromptSegments([
    {path: 'shared/20-voice.md', source: 'x', override: 'y', enabled: true},
    {path: '', source: 'bad'},
    null,
    {path: 'handoff.md'},
  ]);
  assert.deepEqual(decoded, [
    {path: 'shared/20-voice.md', source: 'x', override: 'y', enabled: true},
    {path: 'handoff.md', source: '', override: null, enabled: false},
  ]);
  assert.deepEqual(sw.decodePromptSegments({}), []);
  assert.equal(sw.promptUrl('shared/20-voice.md'), '/api/settings/prompts/shared/20-voice.md');
  assert.equal(sw.promptUrl('a b/c#d.md'), '/api/settings/prompts/a%20b/c%23d.md');
  assert.equal(sw.promptLabel('shared/20-voice.md'), 'voice');
  assert.equal(sw.promptLabel('handoff.md'), 'handoff');
});

test('agent settings decode with defaults and enforce the backend minimums', () => {
  assert.deepEqual(sw.decodeAgentSettings(null), sw.DEFAULT_AGENT_SETTINGS);
  const s = sw.decodeAgentSettings({tools: {demo: false, research: 'yes'}, compaction_tokens: 64000});
  assert.deepEqual(s.tools, {research: true, pdf: true, visual: true, demo: false});
  assert.equal(s.compaction_tokens, 64000);
  assert.equal(s.extraction_chunk_tokens, 4096);
  assert.deepEqual(sw.agentSettingsErrors(s), []);
  assert.deepEqual(sw.agentSettingsErrors({...s, compaction_tokens: 31999, extraction_chunk_tokens: 499}), ['compaction', 'chunk']);
  assert.deepEqual(sw.agentSettingsErrors({...s, compaction_tokens: NaN}), ['compaction']);
  assert.deepEqual(sw.agentSettingsErrors({...s, compaction_tokens: 32000, extraction_chunk_tokens: 500}), []);
});

const ev = (key, mods = {}) => ({key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods});

test('key capture: Escape cancels, modifiers wait, unusable keys are invalid', () => {
  assert.deepEqual(kc.captureCombo(ev('Escape'), false), {kind: 'cancel'});
  assert.deepEqual(kc.captureCombo(ev('Shift', {shiftKey: true}), false), {kind: 'pending'});
  assert.deepEqual(kc.captureCombo(ev('Meta', {metaKey: true}), true), {kind: 'pending'});
  assert.deepEqual(kc.captureCombo(ev('Control', {ctrlKey: true}), false), {kind: 'pending'});
  assert.deepEqual(kc.captureCombo(ev(' '), false), {kind: 'invalid'});
  assert.deepEqual(kc.captureCombo(ev('Dead'), false), {kind: 'invalid'});
  assert.deepEqual(kc.captureCombo(ev('Tab'), false), {kind: 'invalid'});
  assert.deepEqual(kc.captureCombo(ev('Enter'), false), {kind: 'invalid'});
  // Ctrl on macOS has no slot in the registry grammar.
  assert.deepEqual(kc.captureCombo(ev('k', {ctrlKey: true}), true), {kind: 'invalid'});
});

test('key capture builds registry combos that round-trip through matchesCombo', () => {
  const cases = [
    [ev('k', {metaKey: true}), true, 'Mod+K'],
    [ev('k', {ctrlKey: true}), false, 'Mod+K'],
    [ev('F', {ctrlKey: true, shiftKey: true}), false, 'Mod+Shift+F'],
    [ev(',', {metaKey: true}), true, 'Mod+,'],
    [ev('?', {shiftKey: true}), false, '?'],
    [ev('+', {ctrlKey: true, shiftKey: true}), false, 'Mod+Plus'],
    [ev('F2'), false, 'F2'],
    [ev('Enter', {ctrlKey: true}), false, 'Mod+Enter'],
    [ev('Escape', {ctrlKey: true}), false, 'Mod+Escape'],
    [ev('j', {altKey: true}), false, 'Alt+J'],
    [ev('g'), false, 'G'],
  ];
  for (const [event, isMac, combo] of cases) {
    const result = kc.captureCombo(event, isMac);
    assert.deepEqual(result, {kind: 'combo', combo}, combo);
    assert.ok(kb.parseCombo(combo), `parses ${combo}`);
    assert.ok(kb.matchesCombo(event, combo, isMac), `matches ${combo}`);
    assert.deepEqual(kb.sanitizeKeymap({find: combo}), {find: combo});
  }
});

test('command target: claimant wins, else the newest eligible, else none', () => {
  const calls = [];
  const target = (name, {eligible = true, claims = false} = {}) =>
    ({name, run: () => calls.push(name), eligible: () => eligible, claims: () => claims});
  assert.equal(ce.pickCommandTarget([]), null);
  assert.equal(ce.pickCommandTarget([target('a'), target('b')]).name, 'b');
  assert.equal(ce.pickCommandTarget([target('a', {claims: true}), target('b')]).name, 'a');
  assert.equal(ce.pickCommandTarget([target('a'), target('b', {eligible: false})]).name, 'a');
  assert.equal(ce.pickCommandTarget([target('a', {eligible: false, claims: true}), target('b')]).name, 'b');
  assert.equal(ce.pickCommandTarget([target('a', {eligible: false})]), null);
  assert.equal(ce.pickCommandTarget([{run: () => {}}]) !== null, true);
});
