// Guard: the Design System palette lives only in app/globals.css (CSS tokens)
// and lib/palette.ts (literal mirror for Canvas 2D / Excalidraw / metadata).
// Every other source file must use token utilities (bg-background, text-muted-foreground,
// border-border, text-success, ...) — no hex literals, no corporate blue/slate, no pure white.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['app', 'components', 'lib'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

// Files that legitimately hold literal palette values.
const ALLOWLIST = new Set(['app/globals.css', 'lib/palette.ts']);

const RULES = [
  {name: 'hex color literal', re: /#[0-9a-fA-F]{3,8}\b/g},
  {name: 'blue-*', re: /\bblue-/g},
  {name: 'sky-*', re: /\bsky-/g},
  {name: 'indigo-*', re: /\bindigo-/g},
  {name: 'slate-*', re: /\bslate-/g},
  {name: 'text-white', re: /\btext-white\b/g},
  {name: 'bg-white', re: /\bbg-white\b/g},
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function sourceFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  return files.map(f => path.relative(ROOT, f).split(path.sep).join('/'));
}

test('palette literals live only in globals.css and lib/palette.ts', () => {
  const violations = [];
  for (const rel of sourceFiles()) {
    if (ALLOWLIST.has(rel)) continue;
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (m) violations.push(`${rel}:${i + 1} ${rule.name}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(violations, [], `Off-token colors found:\n${violations.join('\n')}`);
});

test('globals.css declares every palette token and exposes it to Tailwind', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
  const tokens = {
    background: '#1a1430', card: '#231b3e', accent: '#30255a', border: '#54458a',
    foreground: '#efeaff', 'muted-foreground': '#a99cd0',
    success: '#34d399', warning: '#e0a030', danger: '#f87171',
  };
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(css, new RegExp(`--${name}:\\s*${value};`, 'i'), `missing :root --${name}`);
    assert.match(css, new RegExp(`--color-${name}:\\s*var\\(--${name}\\);`), `missing @theme --color-${name}`);
  }
});

test('lib/palette.ts mirrors globals.css values', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
  const ts = fs.readFileSync(path.join(ROOT, 'lib/palette.ts'), 'utf8');
  const pairs = {
    background: 'background', card: 'card', accent: 'accent', border: 'border', foreground: 'foreground',
    mutedForeground: 'muted-foreground', success: 'success', warning: 'warning', danger: 'danger',
  };
  for (const [tsKey, cssName] of Object.entries(pairs)) {
    const cssVal = css.match(new RegExp(`--${cssName}:\\s*(#[0-9a-fA-F]{6});`))?.[1];
    const tsVal = ts.match(new RegExp(`\\b${tsKey}:\\s*"(#[0-9a-fA-F]{6})"`))?.[1];
    assert.ok(cssVal && tsVal, `token ${tsKey} missing`);
    assert.equal(tsVal.toLowerCase(), cssVal.toLowerCase(), `palette.${tsKey} drifted from --${cssName}`);
  }
});
