const {test} = require('node:test');
const assert = require('node:assert/strict');
const ni = require('../.test-build/notes-import.js');
const gw = require('../.test-build/graph-wire.js');

test('requests: multipart files[], vault paths deduped, source deletion modes', () => {
  const up = ni.buildNotesUpload([{blob: new Blob(['# a']), name: 'a.md'}, {blob: new Blob(['b']), name: 'b.txt'}]);
  assert.equal(up.path, '/api/graph/import');
  assert.equal(up.method, 'POST');
  assert.deepEqual(up.body.getAll('files[]').map((f) => f.name), ['a.md', 'b.txt']);
  const vault = ni.buildImportVaultNotes(['Notas/a.md', 'Notas/a.md', 'b.md']);
  assert.deepEqual(JSON.parse(vault.body), {paths: ['Notas/a.md', 'b.md']});
  assert.equal(ni.buildImportableNotes().path, '/api/graph/importable-notes');
  assert.deepEqual(ni.buildDeleteSource('src_abc', 'delete-nodes'),
    {path: '/api/graph/sources/src_abc?mode=delete-nodes', method: 'DELETE'});
  assert.equal(ni.sourceNotePath('src_a/b'), '/api/graph/sources/src_a%2Fb/note');
  assert.ok(ni.hasNoteUploadExtension('Aula.PDF'));
  assert.ok(!ni.hasNoteUploadExtension('foto.png'));
});

test('import response and live job files merge per source id', () => {
  const res = ni.decodeNotesImport({
    job: {job_id: 'job-1'},
    files: [
      {filename: 'Notas/a.md', status: 'queued', source_id: 'src_a', path: 'Notas/a.md', title: 'A'},
      {filename: 'foto.png', status: 'rejected', error: 'Only .md'},
      'junk',
    ],
  });
  assert.equal(res.job_id, 'job-1');
  assert.equal(res.files.length, 2);
  assert.equal(res.files[1].status, 'rejected');
  const live = ni.decodeJobFiles({files: [{source_id: 'src_a', path: 'Notas/a.md', title: 'A', status: 'partial',
    batches: 2, new_node_ids: ['n_1', 'n_2'], error: 'boom'}]});
  const merged = ni.mergeJobFiles(res.files, live);
  assert.deepEqual([merged[0].status, merged[0].batches, merged[0].new_nodes, merged[0].error], ['partial', 2, 2, 'boom']);
  assert.equal(merged[1].status, 'rejected');
  assert.ok(ni.isFinalStatus('partial') && !ni.isFinalStatus('running'));
  assert.deepEqual(ni.decodeNotesImport(null), {job_id: null, files: []});
  assert.equal(ni.decodeFileResult({filename: 'x', status: 'weird'}).status, 'queued');
});

test('importable notes decode and the tree groups by folder with accent-free search', () => {
  const listing = ni.decodeImportableNotes({
    truncated: false,
    notes: [
      {path: 'Estudos/Álgebra/Vetores.md', source_id: 'src_1', imported: true},
      {path: 'Estudos/Atenção.md', name: 'Atenção', folder: 'Estudos', source_id: 'src_2'},
      {path: 'solta.md', source_id: 'src_3'},
      {path: 'solta.md'},
      {path: 'imagem.png'},
      42,
    ],
  });
  assert.equal(listing.notes.length, 3);
  assert.equal(listing.notes[0].name, 'Vetores');
  assert.equal(listing.notes[0].folder, 'Estudos/Álgebra');
  assert.equal(listing.notes[0].imported, true);

  const tree = ni.buildNoteTree(listing.notes);
  assert.deepEqual(tree.map((f) => [f.folder, f.depth, f.notes.length]),
    [['', 0, 1], ['Estudos', 0, 1], ['Estudos/Álgebra', 1, 1]]);
  assert.deepEqual(ni.buildNoteTree(listing.notes, 'algebra vet').map((f) => f.folder), ['Estudos/Álgebra']);
  assert.deepEqual(ni.buildNoteTree(listing.notes, 'atencao').map((f) => f.notes[0].name), ['Atenção']);
  assert.deepEqual(ni.buildNoteTree(listing.notes, 'zzz'), []);

  const folder = tree[1];
  assert.equal(ni.folderState(folder, new Set()), 'none');
  assert.equal(ni.folderState(folder, new Set(['Estudos/Atenção.md'])), 'all');
  const two = {folder: 'x', depth: 0, notes: [{path: 'x/a.md'}, {path: 'x/b.md'}]};
  assert.equal(ni.folderState(two, new Set(['x/a.md'])), 'some');
});

test('sources and source note decode', () => {
  const sources = ni.decodeSources([
    {id: 'src_b', path: 'B.md', title: 'Beta', node_count: 3},
    {id: 'src_a', path: 'A.md', title: 'Alfa', node_count: -1},
    {id: '', path: 'x.md'},
  ]);
  assert.deepEqual(sources.map((s) => [s.title, s.node_count]), [['Alfa', 0], ['Beta', 3]]);
  assert.equal(ni.decodeSourceNote({path: 'A.md', markdown: '# A'}).title, 'A.md');
  assert.equal(ni.decodeSourceNote({}), null);
  assert.equal(ni.decodeSourceNote({path: 'A.md', markdown: '---\ntags: [x]\n---\n\n# A\ntexto'}).markdown, '# A\ntexto');
  assert.equal(ni.stripFrontmatter('# sem frontmatter\n---\n'), '# sem frontmatter\n---\n');
});

test('graph nodes carry their note origins and notes clusters keep the path', () => {
  const graph = gw.decodeGraph({
    nodes: [{id: 'n_1', name: 'Softmax', sessions: [], cluster: 'src_a',
      sources: [{source_id: 'src_a', title: 'Atenção', path: 'Estudos/Atenção.md', paragraph: 'p3'},
                {source_id: 'src_a', title: 'Atenção', path: 'Estudos/Atenção.md', paragraph: 'p3'},
                {source_id: 'src_b', title: 'B', path: 'B.md', paragraph: 's2', deleted: true},
                {title: 'no id'}]}],
    clusters: [{id: 'src_a', label: 'Atenção', kind: 'notes', size: 1, path: 'Estudos/Atenção.md'}],
  });
  const node = graph.nodes[0];
  assert.equal(node.sources.length, 2);
  assert.equal(ni.paragraphAnchor(node.sources[0]), '^p3');
  assert.equal(ni.paragraphAnchor(node.sources[1]), null);
  assert.equal(node.sources[1].deleted, true);
  assert.deepEqual(graph.clusters[0], {id: 'src_a', label: 'Atenção', kind: 'notes', size: 1, path: 'Estudos/Atenção.md'});
  assert.deepEqual(gw.decodeNode({id: 'n_2', name: 'X'}).sources, []);
});

test('strings exist in both languages', () => {
  for (const loc of ['pt-BR', 'en']) {
    const t = ni.notesText(loc);
    assert.ok(t.tab && t.originNote('X').includes('X'));
    for (const s of ['queued', 'running', 'completed', 'partial', 'failed', 'rejected']) assert.ok(t.status(s));
  }
  assert.equal(ni.notesText('pt-BR').originNote('Atenção'), 'nota: Atenção');
  assert.equal(ni.notesText('en').tab, 'Add to graph');
});
