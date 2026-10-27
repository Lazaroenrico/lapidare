const test = require('node:test');
const assert = require('node:assert/strict');
const {routeParam} = require('../.test-build/route-param.js');

test('routeParam extracts the segment after the base', () => {
  assert.equal(routeParam('/chat/abc123', 'chat'), 'abc123');
  assert.equal(routeParam('/draw/new', 'draw'), 'new');
});

test('routeParam decodes percent-encoded segments', () => {
  assert.equal(routeParam('/draw/meu%20desenho', 'draw'), 'meu desenho');
  assert.equal(routeParam('/chat/%E0%A4%A', 'chat'), '%E0%A4%A');
});

test('routeParam ignores trailing segments and slashes', () => {
  assert.equal(routeParam('/chat/abc/extra', 'chat'), 'abc');
  assert.equal(routeParam('/chat/abc/', 'chat'), 'abc');
});

test('routeParam returns null when there is no segment or another base', () => {
  assert.equal(routeParam('/chat', 'chat'), null);
  assert.equal(routeParam('/chat/', 'chat'), null);
  assert.equal(routeParam('/settings', 'chat'), null);
  assert.equal(routeParam('/draw/x', 'chat'), null);
  assert.equal(routeParam(null, 'chat'), null);
  assert.equal(routeParam(undefined, 'chat'), null);
});
