const test = require('node:test');
const assert = require('node:assert/strict');
const { bannerFor, statusLabel } = require('../.test-build/updates.js');

const st = (o) => ({ status: 'idle', mode: 'notify', autoUpdate: true, ...o });

test('bannerFor: staged and notify-available only', () => {
  assert.equal(bannerFor(st({ status: 'staged', mode: 'auto' }), 'pt-BR').kind, 'restart');
  const d = bannerFor(st({ status: 'available', version: '2.0.0' }), 'en');
  assert.equal(d.kind, 'download');
  assert.match(d.message, /2\.0\.0/);
  assert.equal(bannerFor(st({ status: 'available', mode: 'auto' }), 'pt-BR'), null);
  assert.equal(bannerFor(st({ status: 'error' }), 'pt-BR'), null);
  assert.equal(bannerFor(null, 'pt-BR'), null);
  assert.equal(bannerFor(undefined, 'pt-BR'), null);
});

test('statusLabel covers every status', () => {
  for (const s of ['idle', 'checking', 'available', 'downloading', 'staged', 'error', 'unsupported']) {
    assert.ok(statusLabel(st({ status: s }), 'pt-BR').length > 0);
  }
  assert.equal(statusLabel(null, 'en'), '');
});
