// Model picker: family grouping, keyboard grid navigation and viewport-safe placement.
const test = require('node:test');
const assert = require('node:assert/strict');

const OUT = require('node:path').join(__dirname, '..', '.test-build');
const mc = require(`${OUT}/model-choice.js`);
const pp = require(`${OUT}/popover-position.js`);

const CATALOG = [
  {id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)'},
  {id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)'},
  {id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)'},
  {id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)'},
  {id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)'},
  {id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)'},
  {id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)'},
  {id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)'},
  {id: 'plain-model', label: 'Plain Model'},
  {id: 'auto', label: 'auto'},
];

test('splitModelVariant strips the effort from id and label', () => {
  assert.deepEqual(mc.splitModelVariant('gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'), {key: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', effort: 'low'});
  assert.deepEqual(mc.splitModelVariant('x-max', ''), {key: 'x', label: 'x', effort: 'max'});
  assert.deepEqual(mc.splitModelVariant('plain', 'Plain'), {key: 'plain', label: 'Plain', effort: null});
});

test('groupModelFamilies: one family per model, efforts ordered low→high, auto excluded', () => {
  const fams = mc.groupModelFamilies(CATALOG);
  assert.deepEqual(fams.map((f) => f.label), ['Gemini 4 Argon', 'Gemini 3.8 Flash', 'Claude Opus 5.5', 'GPT-OSS 120B', 'Plain Model']);
  assert.deepEqual(fams[0].variants.map((v) => v.effort), ['low', 'medium', 'high']);
  assert.deepEqual(fams[2].variants.map((v) => v.id), ['claude-opus-5-5-low']);
  assert.deepEqual(mc.effortVariants(fams[4]), []);
});

test('familyDefaultId prefers plain id, then medium, then first', () => {
  const fams = mc.groupModelFamilies(CATALOG);
  assert.equal(mc.familyDefaultId(fams[0]), 'gemini-4-argon-medium');
  assert.equal(mc.familyDefaultId(fams[2]), 'claude-opus-5-5-low');
  assert.equal(mc.familyDefaultId(fams[4]), 'plain-model');
  const mixed = mc.groupModelFamilies([{id: 'm-high', label: 'M (High)'}, {id: 'm', label: 'M'}]);
  assert.equal(mixed.length, 1);
  assert.equal(mc.familyDefaultId(mixed[0]), 'm');
  assert.deepEqual(mc.effortVariants(mixed[0]).map((v) => v.id), ['m-high']);
});

test('findFamily and filterFamilies', () => {
  const fams = mc.groupModelFamilies(CATALOG);
  assert.equal(mc.findFamily(fams, 'gemini-3.8-flash-high').label, 'Gemini 3.8 Flash');
  assert.equal(mc.findFamily(fams, 'nope'), null);
  assert.deepEqual(mc.filterFamilies(fams, 'flash').map((f) => f.key), ['gemini-3.8-flash']);
  assert.deepEqual(mc.filterFamilies(fams, 'GEMINI argon').map((f) => f.key), ['gemini-4-argon']);
  assert.equal(mc.filterFamilies(fams, '  ').length, fams.length);
});

test('modelTriggerParts: family name + pinned or chosen effort', () => {
  assert.deepEqual(mc.modelTriggerParts('gemini-3.8-flash-medium', CATALOG, 'auto', 'high'), {name: 'Gemini 3.8 Flash', effort: 'medium', pinned: true});
  assert.deepEqual(mc.modelTriggerParts('auto', CATALOG, 'auto', 'low'), {name: 'auto', effort: 'low', pinned: false});
  assert.deepEqual(mc.modelTriggerParts('custom-x', CATALOG, 'auto', 'low'), {name: 'custom-x', effort: 'low', pinned: false});
});

test('pickerNav moves across rows and chips', () => {
  const cols = [1, 4, 2];
  assert.deepEqual(mc.pickerNav(cols, {row: 0, col: 0}, 'ArrowDown'), {row: 1, col: 0});
  assert.deepEqual(mc.pickerNav(cols, {row: 1, col: 3}, 'ArrowDown'), {row: 2, col: 1});
  assert.deepEqual(mc.pickerNav(cols, {row: 2, col: 0}, 'ArrowDown'), {row: 0, col: 0});
  assert.deepEqual(mc.pickerNav(cols, {row: 0, col: 0}, 'ArrowUp'), {row: 2, col: 0});
  assert.deepEqual(mc.pickerNav(cols, {row: 0, col: 0}, 'ArrowUp', true), {row: -1, col: 0});
  assert.deepEqual(mc.pickerNav(cols, {row: -1, col: 0}, 'ArrowDown', true), {row: 0, col: 0});
  assert.deepEqual(mc.pickerNav(cols, {row: 1, col: 3}, 'ArrowRight'), {row: 1, col: 3});
  assert.deepEqual(mc.pickerNav(cols, {row: 1, col: 1}, 'ArrowLeft'), {row: 1, col: 0});
  assert.equal(mc.pickerNav(cols, {row: -1, col: 0}, 'ArrowLeft', true), null);
  assert.equal(mc.pickerNav(cols, {row: 0, col: 0}, 'a'), null);
  assert.equal(mc.pickerNav([], {row: 0, col: 0}, 'ArrowDown'), null);
});

const inside = (pos, vw, vh, margin = 12) => {
  if (pos.mode === 'sheet') return pos.width <= vw && pos.maxHeight <= vh;
  const top = pos.placement === 'down' ? pos.top : vh - pos.bottom - pos.maxHeight;
  const bottom = pos.placement === 'down' ? pos.top + pos.maxHeight : vh - pos.bottom;
  return pos.left >= margin && pos.left + pos.width <= vw - margin && top >= margin && bottom <= vh - margin;
};

test('computePopoverPosition: prefers the requested side when the content fits', () => {
  const trigger = {top: 840, bottom: 868, left: 490, right: 570};
  const pos = pp.computePopoverPosition({trigger, viewport: {width: 1400, height: 900}, width: 380, contentHeight: 500, prefer: 'up'});
  assert.equal(pos.placement, 'up');
  assert.equal(pos.bottom, 900 - 840 + 8);
  assert.equal(pos.left, 490);
  assert.ok(inside(pos, 1400, 900));
});

test('computePopoverPosition: flips to the roomier side and clamps maxHeight', () => {
  const trigger = {top: 80, bottom: 100, left: 280, right: 400};
  const pos = pp.computePopoverPosition({trigger, viewport: {width: 1280, height: 720}, width: 380, contentHeight: 900, prefer: 'up'});
  assert.equal(pos.placement, 'down');
  assert.equal(pos.maxHeight, 720 - 100 - 8 - 12);
  assert.ok(inside(pos, 1280, 720));
});

test('computePopoverPosition: shifts horizontally to stay inside the margin', () => {
  const trigger = {top: 300, bottom: 320, left: 1200, right: 1260};
  const pos = pp.computePopoverPosition({trigger, viewport: {width: 1280, height: 720}, width: 380, contentHeight: 200});
  assert.equal(pos.left, 1280 - 12 - 380);
  assert.ok(inside(pos, 1280, 720));
  const narrow = pp.computePopoverPosition({trigger: {top: 10, bottom: 30, left: 0, right: 40}, viewport: {width: 700, height: 400}, width: 900});
  assert.equal(narrow.width, 700 - 24);
  assert.equal(narrow.left, 12);
  assert.ok(inside(narrow, 700, 400));
});

test('computePopoverPosition: bottom sheet below 640px', () => {
  const pos = pp.computePopoverPosition({trigger: {top: 700, bottom: 730, left: 20, right: 100}, viewport: {width: 390, height: 800}, width: 380});
  assert.equal(pos.mode, 'sheet');
  assert.equal(pos.width, 390);
  assert.equal(pos.maxHeight, 680);
});

test('computePopoverPosition never overflows across a sweep of triggers/viewports', () => {
  for (const [vw, vh] of [[1400, 900], [1280, 720], [800, 500], [640, 360]]) {
    for (let top = 0; top <= vh; top += 37) {
      for (let left = 0; left <= vw; left += 53) {
        const trigger = {top, bottom: Math.min(vh, top + 28), left, right: left + 100};
        for (const prefer of ['up', 'down']) {
          const pos = pp.computePopoverPosition({trigger, viewport: {width: vw, height: vh}, width: 380, contentHeight: 600, prefer});
          assert.ok(inside(pos, vw, vh), JSON.stringify({vw, vh, trigger, prefer, pos}));
        }
      }
    }
  }
});
