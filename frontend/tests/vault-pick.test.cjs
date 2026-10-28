const test = require('node:test');
const assert = require('node:assert/strict');
const { needsCreateConfirm, vaultHint, vaultPickText } = require('../.test-build/vault-pick.js');

const check = (o) => ({ ok: true, error: null, message: null, path: '/v', exists: true, obsidian: false, lapidare: false, ...o });

test('vaultHint: errors, new folder, Obsidian and Lapidare vaults', () => {
  assert.equal(vaultHint(null, 'pt-BR'), null);
  for (const error of ['empty', 'relative', 'not_dir', 'not_writable']) {
    const h = vaultHint(check({ ok: false, error, path: null }), 'pt-BR');
    assert.equal(h.tone, 'error');
    assert.equal(h.message, vaultPickText('pt-BR').errors[error]);
  }
  const fresh = vaultHint(check({ exists: false, path: '/home/u/Novo' }), 'en');
  assert.equal(fresh.tone, 'info');
  assert.match(fresh.message, /\/home\/u\/Novo/);
  assert.equal(vaultHint(check({ obsidian: true }), 'pt-BR').message, vaultPickText('pt-BR').obsidian);
  assert.equal(vaultHint(check({ obsidian: true, lapidare: true }), 'en').message, vaultPickText('en').lapidare);
  assert.equal(vaultHint(check({}), 'en').message, vaultPickText('en').folder);
});

test('needsCreateConfirm: only a missing folder not yet confirmed', () => {
  assert.equal(needsCreateConfirm(check({ exists: false, path: '/n' }), null), true);
  assert.equal(needsCreateConfirm(check({ exists: false, path: '/n' }), '/n'), false);
  assert.equal(needsCreateConfirm(check({ exists: false, path: '/n' }), '/outro'), true);
  assert.equal(needsCreateConfirm(check({ exists: true }), null), false);
  assert.equal(needsCreateConfirm(check({ ok: false, error: 'relative', exists: false, path: null }), null), false);
});

test('PT-BR and EN cover the same keys', () => {
  const pt = vaultPickText('pt-BR');
  const en = vaultPickText('en-US');
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort());
  assert.notEqual(pt.choose, en.choose);
});
