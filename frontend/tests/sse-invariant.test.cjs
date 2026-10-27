// Guard (AGENTS.md §6): one EventSource("/api/events") per window, notify -> fetch,
// and never a setInterval polling loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['app', 'components', 'lib'];

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => sources(path.join(ROOT, d)))
  .map((file) => ({rel: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8')}));

test('no setInterval anywhere (notify -> fetch only)', () => {
  const hits = files.filter((f) => /\bsetInterval\s*\(/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(hits, []);
});

test('exactly one EventSource, in the server-events provider', () => {
  const hits = files.flatMap((f) => (f.text.match(/new EventSource\s*\(/g) ?? []).map(() => f.rel));
  assert.deepEqual(hits, ['components/server-events.tsx']);
});
