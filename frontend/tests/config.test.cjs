const {test} = require('node:test');
const assert = require('node:assert/strict');
const {encodeConfig, decodeSetup} = require('/tmp/learnharness-frontend-tests/config-wire.js');
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
