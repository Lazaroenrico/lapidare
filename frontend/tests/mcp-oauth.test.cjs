const {test} = require('node:test');
const assert = require('node:assert/strict');
const wire = require('../.test-build/import-wire.js');

test('upsert sends the auth mode, scopes, and the token only in token mode', () => {
  const oauth = JSON.parse(wire.buildUpsertMcpServer({name:'r', transport:'http', url:'https://x/mcp', auth_mode:'oauth', oauth_scopes:[' read ','','write'], auth_token:'leak'}).body);
  assert.equal(oauth.auth_mode, 'oauth');
  assert.deepEqual(oauth.oauth_scopes, ['read','write']);
  assert.equal(oauth.auth_token, undefined);
  const token = JSON.parse(wire.buildUpsertMcpServer({name:'r', transport:'http', url:'https://x/mcp', auth_mode:'token', auth_token:'t'}).body);
  assert.equal(token.auth_token, 't');
  assert.equal(token.oauth_scopes, undefined);
  const stdio = JSON.parse(wire.buildUpsertMcpServer({name:'s', transport:'stdio', command:'uvx', auth_mode:'oauth'}).body);
  assert.equal(stdio.auth_mode, 'none');
});

test('login and logout requests', () => {
  assert.deepEqual(wire.buildMcpOAuthLogin('a b'), {path:'/api/import/mcp/servers/a%20b/oauth/login', method:'POST'});
  assert.equal(wire.buildMcpOAuthLogout('x').path, '/api/import/mcp/servers/x/oauth/logout');
});

test('server decoding is backwards compatible and tolerant', () => {
  const old = wire.decodeMcpServer({name:'a', transport:'http', url:'u', command:null, args:[], enabled:true, has_auth:true});
  assert.equal(old.auth_mode, 'token');
  assert.equal(old.oauth, null);
  const none = wire.decodeMcpServer({name:'a', transport:'http', url:'u', command:null, args:[], enabled:true, has_auth:false});
  assert.equal(none.auth_mode, 'none');
  const o = wire.decodeMcpServer({name:'a', transport:'http', url:'u', command:null, args:[], enabled:true, has_auth:false, auth_mode:'oauth', oauth:{status:'error', error:'boom'}});
  assert.deepEqual(o.oauth, {status:'error', error:'boom'});
  assert.deepEqual(wire.decodeOAuthState({status:'weird'}), {status:'signed_out'});
  assert.equal(wire.decodeOAuthState(null), null);
});

test('only http(s) authorization urls are accepted', () => {
  assert.equal(wire.decodeAuthorizationUrl({authorization_url:'https://a.test/authorize?x=1'}), 'https://a.test/authorize?x=1');
  assert.throws(() => wire.decodeAuthorizationUrl({authorization_url:'javascript:alert(1)'}));
  assert.throws(() => wire.decodeAuthorizationUrl({authorization_url:'file:///etc/passwd'}));
  assert.throws(() => wire.decodeAuthorizationUrl({}));
});
