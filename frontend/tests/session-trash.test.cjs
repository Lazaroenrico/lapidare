const {test} = require('node:test');
const assert = require('node:assert/strict');
const tr = require('../.test-build/session-trash.js');

test('trash entries decode, drop invalid rows and sort by deletion time', () => {
  const list = tr.decodeTrashList([
    {id: 's1', file: 's1.jsonl', title: ' Álgebra ', mode: 'TEACH', deleted_at: '2026-10-27T10:00:00+00:00',
     updated_at: '2026-10-26T10:00:00+00:00', message_count: 4, graph_unlinked: false},
    {id: 's2', file: 's2.20260101T000000.jsonl', title: 'Prática', mode: 'PRACTICE',
     deleted_at: '2026-10-27T12:00:00+00:00', message_count: 1, graph_unlinked: true},
    {id: 's3', file: '../config.json'},
    {file: 'nobody.jsonl'},
    'garbage',
    null,
    {id: 's1', file: 's1.jsonl', deleted_at: '2026-10-27T10:00:00+00:00'},
  ]);
  assert.deepEqual(list.map((e) => e.id), ['s2', 's1']);
  const [s2, s1] = list;
  assert.equal(s1.title, 'Álgebra');
  assert.equal(s1.mode, 'TEACH');
  assert.equal(s1.message_count, 4);
  assert.equal(s1.updated_at, '2026-10-26T10:00:00+00:00');
  assert.equal(s2.mode, 'PRACTICE');
  assert.equal(s2.graph_unlinked, true);
  assert.equal(s2.updated_at, null);
  assert.deepEqual(tr.decodeTrashList({not: 'a list'}), []);
});

test('legacy entries without counts or flags get safe defaults', () => {
  const e = tr.decodeTrashEntry({id: 'old', file: 'old.jsonl', mode: 'WEIRD', message_count: -3, graph_unlinked: 'yes'});
  assert.equal(e.mode, 'TEACH');
  assert.equal(e.message_count, 0);
  assert.equal(e.graph_unlinked, false);
  assert.equal(e.deleted_at, '');
  assert.equal(e.title, '');
});

test('restore response decodes the session id and graph flag', () => {
  assert.deepEqual(tr.decodeRestoreResult({session: {id: 'sess-1'}, graph_restored: false}),
    {sessionId: 'sess-1', graphRestored: false});
  assert.deepEqual(tr.decodeRestoreResult(null), {sessionId: null, graphRestored: false});
});

test('request paths encode the file name and require confirm for purge', () => {
  assert.equal(tr.trashRestorePath('a b.jsonl'), '/api/chats/trash/a%20b.jsonl/restore');
  assert.equal(tr.trashPurgePath('../x.jsonl'), '/api/chats/trash/..%2Fx.jsonl?confirm=true');
  assert.equal(tr.TRASH_LIST_PATH, '/api/chats/trash');
});

test('only trash-changing SSE frames trigger a refetch', () => {
  assert.equal(tr.touchesTrash({session_id: 's', deleted: true}), true);
  assert.equal(tr.touchesTrash({session_id: 's', restored: true}), true);
  assert.equal(tr.touchesTrash({trash_file: 'x.jsonl', purged: true}), true);
  assert.equal(tr.touchesTrash({resync: true}), true);
  assert.equal(tr.touchesTrash({session_id: 's', sequence: 3}), false);
  assert.equal(tr.touchesTrash({session_id: 's', streaming: true}), false);
});

test('strings exist in both locales', () => {
  for (const locale of ['pt-BR', 'en']) {
    const t = tr.trashText(locale);
    assert.ok(t.entry(2).includes('2'));
    assert.ok(t.purgeBody('X').includes('X'));
    assert.ok(t.messages(1) && t.messages(3));
  }
  assert.equal(tr.trashText('pt-BR').entry(3), 'Lixeira (3)');
  assert.equal(tr.trashText('en').purge, 'Delete permanently');
});
