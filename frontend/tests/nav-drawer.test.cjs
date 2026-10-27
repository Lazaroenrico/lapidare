// Narrow-viewport sidebar drawer, prompt editor dirty state, dictation command routing.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const nd = require('../.test-build/nav-drawer.js');
const sw = require('../.test-build/settings-wire.js');
const ce = require('../.test-build/command-events.js');

test('wide viewports keep the persisted collapse; narrow ones always use the full drawer', () => {
  assert.deepEqual(nd.sidebarPresentation(false, false, false), {variant: 'full', drawer: false, open: false});
  assert.deepEqual(nd.sidebarPresentation(false, true, true), {variant: 'rail', drawer: false, open: false});
  assert.deepEqual(nd.sidebarPresentation(true, true, false), {variant: 'full', drawer: true, open: false});
  assert.deepEqual(nd.sidebarPresentation(true, false, true), {variant: 'full', drawer: true, open: true});
});

test('the toggle-sidebar shortcut opens the drawer on narrow viewports and collapses otherwise', () => {
  assert.equal(nd.toggleSidebarAction(true), 'drawer');
  assert.equal(nd.toggleSidebarAction(false), 'collapse');
  assert.equal(nd.NARROW_QUERY, '(max-width: 767px)');
});

test('prompt editor: baseline and dirty state', () => {
  const plain = {path: 'shared/20-voice.md', source: 'orig', override: null, enabled: false};
  const over = {path: 'shared/20-voice.md', source: 'orig', override: 'mine', enabled: false};
  assert.deepEqual(sw.promptBaseline(plain), {text: 'orig', enabled: true});
  assert.deepEqual(sw.promptBaseline(over), {text: 'mine', enabled: false});
  // Without an override, saving the untouched original (even with the switch flipped) is a no-op.
  assert.equal(sw.promptDirty(plain, 'orig', true), false);
  assert.equal(sw.promptDirty(plain, 'orig', false), false);
  assert.equal(sw.promptDirty(plain, 'orig!', true), true);
  assert.equal(sw.promptDirty(over, 'mine', false), false);
  assert.equal(sw.promptDirty(over, 'mine', true), true);
  assert.equal(sw.promptDirty(over, 'orig', false), true);
});

test('dictation targets: focused field wins, hidden fields are skipped, a listening one keeps the command', () => {
  // Mount order on the session page: follow-up bar, then a question dock.
  const dock = (name, {enabled = true, focused = false, listening = false} = {}) => ({
    name,
    run: () => {},
    eligible: () => enabled || listening,
    claims: () => listening || focused,
  });
  assert.equal(ce.pickCommandTarget([dock('footer'), dock('quiz')]).name, 'quiz');
  assert.equal(ce.pickCommandTarget([dock('footer', {focused: true}), dock('quiz')]).name, 'footer');
  assert.equal(ce.pickCommandTarget([dock('footer'), dock('quiz', {enabled: false})]).name, 'footer');
  assert.equal(ce.pickCommandTarget([dock('footer', {listening: true}), dock('quiz')]).name, 'footer');
  assert.equal(ce.pickCommandTarget([dock('footer'), dock('quiz', {enabled: false, listening: true})]).name, 'quiz');
  assert.equal(ce.pickCommandTarget([dock('footer', {enabled: false}), dock('quiz', {enabled: false})]), null);
});
