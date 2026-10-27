const {test} = require('node:test');
const assert = require('node:assert/strict');
const {encodeConfig, decodeSetup} = require('../.test-build/config-wire.js');
test('canonical setup carries credentials only in request and translates each model slot', () => {
  const slot = {engine: 'gemini', model: 'chosen-model', effort: 'high'};
  const wire = encodeConfig({initialized:true, language:'pt-br', slots:{strong:slot,fast:{...slot,engine:'sdk'},background:slot},track:{mode:'repo_binary',active:true}, content_mcps:[{name:'content',url:'http://localhost/mcp',active:true}]}, 'secret');
  assert.equal(wire.slots.strong.model_id,'chosen-model');
  assert.equal(wire.slots.fast.engine,'genai_sdk');
  assert.equal(wire.slots.strong.engine,'gemini_cli');
  assert.equal(wire.language,'pt-BR');
  assert.equal(wire.api_key,'secret');
  assert.equal(wire.track.mode,'repo_leveling');
  assert.equal(wire.content_mcps[0].enabled,true);
  assert.equal(wire.track.queue,undefined, 'settings edits must not replace track progress with an empty queue');
});
test('canonical status restores selected models and active track source', () => {
  const value=decodeSetup({configured:true,config:{configured:true,language:'en',slots:{strong:{engine:'genai_sdk',model_id:'custom'}},track:{mode:'repo_leveling',active_item_id:'step2',queue:[{id:'step2',title:'Lesson',source_ref:'Sources/read.md'}]}},connectors:[{engine:'gemini_cli',models:['custom'],detail:'ready'}]});
  assert.equal(value.initialized,true);
  assert.equal(value.config.slots.strong.model,'custom');
  assert.equal(value.config.track.items[0].current,true);
  assert.equal(value.config.track.items[0].source_path,'Sources/read.md');
  assert.deepEqual(value.connectors[0].available_models,['custom']);
});
test('settings save round-trips the chosen model_id per slot (agy model picker)', () => {
  const {encodeConfig, decodeConfig, encodeSlot, modelPinsEffort} = require('../.test-build/config-wire.js');
  const slots = {
    strong: {engine: 'agy', model: 'gemini-3.8-flash-low', effort: 'high'},
    fast: {engine: 'agy', model: 'auto', effort: 'low'},
    background: {engine: 'sdk', model: 'custom-id', effort: 'medium'},
  };
  const wire = encodeConfig({slots});
  assert.deepEqual(wire.slots.strong, {engine: 'agy', model_id: 'gemini-3.8-flash-low', effort: 'high'});
  assert.equal(wire.slots.fast.model_id, 'auto');
  assert.equal(wire.slots.background.engine, 'genai_sdk');
  const back = decodeConfig({slots: wire.slots});
  assert.equal(back.slots.strong.model, 'gemini-3.8-flash-low');
  assert.equal(back.slots.background.engine, 'sdk');
  assert.equal(back.slots.background.model, 'custom-id');
  assert.deepEqual(encodeSlot({engine: 'gemini', model: '  ', effort: 'low'}), {engine: 'gemini_cli', model_id: 'auto', effort: 'low'});
  assert.equal(modelPinsEffort('gemini-4-argon-medium'), true);
  assert.equal(modelPinsEffort('gemini-3.8-flash'), false);
  assert.equal(modelPinsEffort('auto'), false);
});
test('missing or legacy agy models fall back to auto, never gemini-2.5-*', () => {
  const {normalizeSlots} = require('../.test-build/config-wire.js');
  const empty = normalizeSlots(undefined);
  for (const name of ['strong', 'fast', 'background']) {
    assert.equal(empty[name].engine, 'agy');
    assert.equal(empty[name].model, 'auto');
  }
  const legacy = normalizeSlots({strong: {engine: 'agy', model: 'gemini-2.5-pro'}, fast: {engine: 'gemini', model: 'gemini-2.5-flash'}});
  assert.equal(legacy.strong.model, 'auto');
  assert.equal(legacy.fast.model, 'gemini-2.5-flash', 'other engines keep their saved model');
  assert.equal(legacy.background.model, 'auto');
});
