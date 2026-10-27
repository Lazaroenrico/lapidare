// Fase 15: nivelamento de trilha — button visibility, card decoding, transcript placement.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = '/tmp/learnharness-frontend-tests';
const lv = require(`${OUT}/leveling.js`);
const sw = require(`${OUT}/session-wire.js`);
const i18n = require(`${OUT}/tracks-i18n.js`);

const track = (over = {}) => ({archived: false, generating: false, progress: {done: 1, total: 6}, ...over});

test('the leveling button needs 4+ pending steps on a live, idle track', () => {
  assert.equal(lv.pendingSteps(track()), 5);
  assert.equal(lv.canLevelTrack(track()), true);
  assert.equal(lv.canLevelTrack(track({progress: {done: 2, total: 6}})), true);
  assert.equal(lv.canLevelTrack(track({progress: {done: 3, total: 6}})), false);
  assert.equal(lv.canLevelTrack(track({archived: true})), false);
  assert.equal(lv.canLevelTrack(track({generating: true})), false);
  assert.equal(lv.canLevelTrack(track({progress: {done: 0, total: 0}})), false);
  assert.equal(lv.pendingSteps(track({progress: {done: 9, total: 4}})), 0);
});

test('decodeLeveling is defensive and keeps titles for the card', () => {
  assert.equal(lv.decodeLeveling(null), null);
  assert.equal(lv.decodeLeveling({known_items: []}), null);
  const d = lv.decodeLeveling({
    track_id: 'trk-1', known_items: [{id: 's1', title: 'Funções'}, {id: 's2'}, {title: 'sem id'}, 'junk'],
    start_item: {id: 's3', title: 'Derivadas'}, summary: '  Sabe limites. ', created_at: 't', undone_at: null,
  });
  assert.deepEqual(d.known_items, [{id: 's1', title: 'Funções'}, {id: 's2', title: 's2'}]);
  assert.deepEqual(d.start_item, {id: 's3', title: 'Derivadas'});
  assert.equal(d.summary, 'Sabe limites.');
  assert.equal(d.undone_at, null);
  assert.equal(lv.decodeLeveling({track_id: 'x', undone_at: '2026-10-27'}).undone_at, '2026-10-27');
  assert.equal(lv.decodeLeveling({track_id: 'x'}).start_item, null);
});

test('isLevelingSession reads teach_context or context_kind', () => {
  assert.equal(lv.isLevelingSession({teach_context: 'leveling'}), true);
  assert.equal(lv.isLevelingSession({context_kind: 'leveling'}), true);
  assert.equal(lv.isLevelingSession({teach_context: 'track_step'}), false);
});

test('decodeSession carries the leveling and the transcript ends with its card', () => {
  const session = sw.decodeSession({
    id: 's', mode: 'TEACH', phase: 'completed', teach_context: 'leveling', answers: [],
    messages: [{id: 'm1', role: 'assistant', content: 'Começa em Derivadas.', created_at: '1'}],
    leveling: {track_id: 'trk-1', known_items: [{id: 's1', title: 'Funções'}], start_item: {id: 's3', title: 'Derivadas'}},
  });
  assert.equal(session.leveling.known_items.length, 1);
  const items = sw.buildTranscript(session);
  assert.equal(items[items.length - 1].type, 'leveling_done');
  assert.equal(sw.buildTranscript({...session, leveling: null}).some((i) => i.type === 'leveling_done'), false);
  assert.equal(sw.decodeSession({id: 'x'}).leveling, null);
});

test('leveling strings exist in both languages', () => {
  for (const locale of ['pt-BR', 'en']) {
    const tt = i18n.tracksText(locale);
    assert.ok(tt.levelTrack && tt.levelingUndo && tt.levelingPhase);
    assert.match(tt.levelingKnown(3), /3/);
    assert.match(tt.levelingStart('X'), /X/);
  }
  assert.equal(i18n.tracksText('pt-BR').levelingKnown(2), '2 passos marcados como já sabidos');
  assert.equal(i18n.tracksText('en').levelingPhase, 'Leveling');
});
