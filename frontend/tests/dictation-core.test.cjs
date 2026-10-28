const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../.test-build/dictation-core.js');

const result = (transcript, is_final = true, type = 'Results') => ({type, is_final, channel: {alternatives: [{transcript}]}});

test('listenUrl carries the streaming parameters and falls back to multi', () => {
  const url = new URL(core.listenUrl('pt-BR'));
  assert.equal(url.origin, 'wss://api.deepgram.com');
  assert.equal(url.pathname, '/v1/listen');
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('language'), 'pt-BR');
  assert.equal(url.searchParams.get('encoding'), 'linear16');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.equal(url.searchParams.get('channels'), '1');
  assert.equal(url.searchParams.get('smart_format'), 'true');
  assert.equal(url.searchParams.get('endpointing'), '300');
  assert.equal(url.searchParams.get('interim_results'), 'false');
  assert.equal(new URL(core.listenUrl('klingon')).searchParams.get('language'), 'multi');
  assert.deepEqual(core.listenProtocols('jwt'), ['bearer', 'jwt']);
});

test('reduceTranscript joins final results only, ignoring empties and other messages', () => {
  let acc = '';
  acc = core.reduceTranscript(acc, result('olá mundo'));
  acc = core.reduceTranscript(acc, result('parcial', false));
  acc = core.reduceTranscript(acc, result('   '));
  acc = core.reduceTranscript(acc, result('x', true, 'Metadata'));
  acc = core.reduceTranscript(acc, null);
  acc = core.reduceTranscript(acc, {type: 'Results', is_final: true, channel: {alternatives: []}});
  acc = core.reduceTranscript(acc, result(' segunda frase '));
  assert.equal(acc, 'olá mundo segunda frase');
});

test('parseMessage tolerates binary and invalid frames', () => {
  assert.equal(core.parseMessage(new ArrayBuffer(2)), null);
  assert.equal(core.parseMessage('{oops'), null);
  assert.deepEqual(core.parseMessage('{"a":1}'), {a: 1});
});

test('state machine follows idle → requesting → listening → finishing → idle', () => {
  let s = 'idle';
  for (const [event, expected] of [['start', 'requesting'], ['ready', 'listening'], ['stop', 'finishing'], ['closed', 'idle']]) {
    s = core.nextState(s, event);
    assert.equal(s, expected);
  }
  assert.equal(core.nextState('idle', 'ready'), 'idle');
  assert.equal(core.nextState('requesting', 'stop'), 'idle');
  assert.equal(core.nextState('listening', 'closed'), 'idle');
});

test('fail reaches error from any state; cancel and reset return to idle; error can restart', () => {
  for (const s of ['idle', 'requesting', 'listening', 'finishing', 'error']) {
    assert.equal(core.nextState(s, 'fail'), 'error');
    assert.equal(core.nextState(s, 'cancel'), 'idle');
  }
  assert.equal(core.nextState('error', 'reset'), 'idle');
  assert.equal(core.nextState('error', 'start'), 'requesting');
  assert.ok(core.isActive('listening') && !core.isActive('idle') && !core.isActive('error'));
});

test('errorMessage maps HTTP status per locale', () => {
  assert.match(core.errorMessage(401, 'pt-BR'), /inválida/);
  assert.match(core.errorMessage(401, 'en'), /Invalid/);
  assert.match(core.errorMessage(403, 'pt-BR'), /Member/);
  assert.match(core.errorMessage(409, 'en'), /not configured/);
  assert.match(core.errorMessage(502, 'pt-BR'), /indisponível/);
  assert.match(core.errorMessage(0, 'en'), /unavailable/);
});

test('levelFromRms is bounded and quantized', () => {
  assert.equal(core.levelFromRms(0), 0);
  assert.equal(core.levelFromRms(NaN), 0);
  assert.equal(core.levelFromRms(5), 1);
  const mid = core.levelFromRms(0.05);
  assert.ok(mid > 0 && mid < 1);
  assert.equal(Math.round(mid * 20), mid * 20);
});

test('decodeDictationSettings defaults safely', () => {
  assert.deepEqual(core.decodeDictationSettings({configured: true, language: 'en-US'}), {configured: true, language: 'en-US'});
  assert.deepEqual(core.decodeDictationSettings({configured: 'yes', language: 'xx'}), {configured: false, language: 'multi'});
  assert.deepEqual(core.decodeDictationSettings(null), {configured: false, language: 'multi'});
});
