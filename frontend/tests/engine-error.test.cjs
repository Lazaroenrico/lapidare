// Failed-run card: quota/limit classification of the (redacted) error text.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const OUT = require('node:path').join(__dirname, '..', '.test-build');
const ee = require(`${OUT}/engine-error.js`);

test('quota and limit messages are classified as quota', () => {
  const real = 'Antigravity CLI turn failed: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 65h21m';
  assert.equal(ee.classifyEngineError(real), 'quota');
  assert.equal(ee.classifyEngineError('Rate limited by upstream'), 'quota');
  assert.equal(ee.classifyEngineError('Resets in 2h'), 'quota');
});

test('other errors and empty text are not quota', () => {
  assert.equal(ee.classifyEngineError('Process exited with code 1'), 'other');
  assert.equal(ee.classifyEngineError(''), 'other');
  assert.equal(ee.classifyEngineError(null), 'other');
});

test('the card shows only for a failed run with an error text', () => {
  assert.equal(ee.showsEngineErrorCard({execution_status: 'failed', error: 'boom'}), true);
  assert.equal(ee.showsEngineErrorCard({execution_status: 'failed', error: '  '}), false);
  assert.equal(ee.showsEngineErrorCard({execution_status: 'failed', error: null}), false);
  assert.equal(ee.showsEngineErrorCard({execution_status: 'running', error: 'boom'}), false);
});
