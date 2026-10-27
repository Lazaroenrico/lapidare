const {test} = require('node:test');
const assert = require('node:assert/strict');
const kb = require('/tmp/learnharness-frontend-tests/keyboard.js');

const ev = (key, mods = {}) => ({key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods});

test('Mod maps to Cmd on mac and Ctrl elsewhere; Shift is checked for letters', () => {
  assert.ok(kb.matchesCombo(ev('k', {metaKey: true}), 'Mod+K', true));
  assert.ok(!kb.matchesCombo(ev('k', {ctrlKey: true}), 'Mod+K', true));
  assert.ok(kb.matchesCombo(ev('k', {ctrlKey: true}), 'Mod+K', false));
  assert.ok(kb.matchesCombo(ev('F', {ctrlKey: true, shiftKey: true}), 'Mod+Shift+F', false));
  assert.ok(!kb.matchesCombo(ev('f', {ctrlKey: true}), 'Mod+Shift+F', false));
});

test('shifted symbols match without restating Shift', () => {
  assert.ok(kb.matchesCombo(ev('?', {shiftKey: true}), '?', false));
  assert.ok(kb.matchesCombo(ev('Escape'), 'Escape', true));
});

test('keymap sanitizing drops unknown ids and invalid combos; conflicts are reported', () => {
  assert.deepEqual(kb.sanitizeKeymap({find: 'Mod+J', nope: 'Mod+X', rename: 'Hyper+R'}), {find: 'Mod+J'});
  assert.equal(kb.comboFor('find', {}), 'Mod+F');
  const clash = kb.conflicts({find: 'Mod+K'});
  assert.ok(clash.some((ids) => ids.includes('find') && ids.includes('modelPicker')));
  assert.deepEqual(kb.conflicts({}), []);
});

test('formatCombo renders platform labels', () => {
  assert.equal(kb.formatCombo('Mod+Shift+F', true), '⌘⇧F');
  assert.equal(kb.formatCombo('Mod+Shift+F', false), 'Ctrl+Shift+F');
  assert.equal(kb.formatCombo('Escape', false), 'Esc');
});
