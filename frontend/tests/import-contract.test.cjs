const {test} = require('node:test');
const assert = require('node:assert/strict');
// lib/import-wire.ts compiled by `npm test` (tsconfig.test.json).
const wire = require('../.test-build/import-wire.js');

test('MCP routes follow the contract and escape server names', () => {
  assert.deepEqual(wire.buildListMcpServers(), {path: '/api/import/mcp/servers', method: 'GET'});
  assert.deepEqual(wire.buildDeleteMcpServer('my srv'), {path: '/api/import/mcp/servers/my%20srv', method: 'DELETE'});
  assert.equal(wire.buildTestMcpServer('praxis').path, '/api/import/mcp/servers/praxis/test');
  assert.equal(wire.buildTestMcpServer('praxis').method, 'POST');
  assert.equal(wire.buildListMcpItems('praxis').path, '/api/import/mcp/servers/praxis/items');
  const imp = wire.buildImportMcpItems('praxis', ['a', 'b'], false);
  assert.equal(imp.path, '/api/import/mcp/servers/praxis/import');
  assert.deepEqual(JSON.parse(imp.body), {item_ids: ['a', 'b'], start_session: false});
});

test('MCP upsert sends only transport-relevant fields and omits a blank token', () => {
  const http = JSON.parse(wire.buildUpsertMcpServer({
    name: ' praxis ', transport: 'http', url: ' http://localhost/mcp ', command: 'ignored', args: ['x'],
    enabled: true, auth_token: '   ', catalog_tool: '', content_tool: 'get_lesson', content_id_argument: '',
  }).body);
  assert.deepEqual(http, {name: 'praxis', transport: 'http', url: 'http://localhost/mcp', enabled: true, content_tool: 'get_lesson'});

  const stdio = wire.buildUpsertMcpServer({
    name: 'local', transport: 'stdio', command: 'uvx', args: ['srv', '', ' --stdio '], auth_token: 'tok',
  });
  assert.equal(stdio.path, '/api/import/mcp/servers');
  assert.equal(stdio.method, 'POST');
  assert.deepEqual(JSON.parse(stdio.body), {name: 'local', transport: 'stdio', command: 'uvx', args: ['srv', '--stdio'], auth_token: 'tok'});
});

test('GitHub preview/import bodies match the contract', () => {
  const pv = wire.buildGithubPreview(' https://github.com/o/r ');
  assert.equal(pv.path, '/api/import/github/preview');
  assert.deepEqual(JSON.parse(pv.body), {url: 'https://github.com/o/r'});

  const im = wire.buildGithubImport({url: 'https://github.com/o/r', paths: ['a.md'], start_session: true, use_as_track: false});
  assert.equal(im.path, '/api/import/github/import');
  assert.deepEqual(JSON.parse(im.body), {url: 'https://github.com/o/r', paths: ['a.md'], start_session: true, use_as_track: false});

  // Fase 14: use_as_track creates a new track; replace_track is no longer sent.
  const track = JSON.parse(wire.buildGithubImport({url: 'https://github.com/o/r', paths: [], start_session: false, use_as_track: true, replace_track: true}).body);
  assert.deepEqual(track, {url: 'https://github.com/o/r', paths: [], start_session: false, use_as_track: true});
});

test('GitHub URL guard accepts repo/tree links and rejects other schemes', () => {
  assert.ok(wire.isGithubRepoUrl('https://github.com/owner/ai-engineering-from-scratch'));
  assert.ok(wire.isGithubRepoUrl('https://github.com/owner/repo/tree/main/docs/week1'));
  assert.ok(!wire.isGithubRepoUrl('git@github.com:owner/repo.git'));
  assert.ok(!wire.isGithubRepoUrl('file:///etc/passwd'));
  assert.ok(!wire.isGithubRepoUrl('https://gitlab.com/owner/repo'));
});

test('local import is multipart with file, optional title and start_session', () => {
  const blob = new Blob(['# hi'], {type: 'text/markdown'});
  const spec = wire.buildLocalImport(blob, 'aula.md', '  Aula 1 ', true);
  assert.equal(spec.path, '/api/import/local');
  assert.equal(spec.method, 'POST');
  assert.ok(spec.body instanceof FormData);
  assert.equal(spec.body.get('title'), 'Aula 1');
  assert.equal(spec.body.get('start_session'), 'true');
  assert.equal(spec.body.get('file').name, 'aula.md');
  const untitled = wire.buildLocalImport(blob, 'x.pdf', '', false).body;
  assert.equal(untitled.has('title'), false);
  assert.equal(untitled.get('start_session'), 'false');
  assert.ok(wire.hasLocalImportExtension('Notes.MARKDOWN'));
  assert.ok(!wire.hasLocalImportExtension('slides.pptx'));
});
