"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const i = require("../integration.cjs");

const AI = "/home/u/Applications/Lapidare.AppImage";

test("buildEntry: conteudo exato", () => {
  assert.equal(
    i.buildEntry({ appImage: AI, extractAndRun: false }),
    `[Desktop Entry]
Type=Application
Name=Lapidare
Comment=Estude com um tutor que mede, planeja e ensina
Exec="${AI}" %U
Icon=lapidare
Terminal=false
Categories=Education;
StartupWMClass=lapidare
X-Lapidare-Managed=true
`,
  );
});
test("buildEntry: flag, escapes e rejeicoes", () => {
  assert.match(i.buildEntry({ appImage: AI, extractAndRun: true }), /^Exec="[^"]+" --appimage-extract-and-run %U$/m);
  assert.match(i.buildEntry({ appImage: '/a b/$x`y"z%.AppImage' }), /^Exec="\/a b\/\\\$x\\`y\\"z%%\.AppImage" %U$/m);
  assert.throws(() => i.buildEntry({ appImage: "rel/x" }));
  assert.throws(() => i.buildEntry({ appImage: "/a\nExec=evil" }));
});
test("isManaged / decideEntry", () => {
  const d = i.buildEntry({ appImage: AI });
  assert.equal(i.isManaged(d), true);
  assert.equal(i.isManaged("[Desktop Entry]\nName=Lapidare\n"), false);
  assert.equal(i.isManaged("X-Lapidare-Managed=false\n"), false);
  assert.equal(i.decideEntry(null, d), "create");
  assert.equal(i.decideEntry(d, d), "keep");
  assert.equal(i.decideEntry(i.buildEntry({ appImage: "/old/x.AppImage" }), d), "rewrite");
  assert.equal(i.decideEntry("[Desktop Entry]\nName=Meu\n", d), "skip");
});
test("decideIcon", () => {
  const b = Buffer.from("png");
  assert.equal(i.decideIcon(null, b), "create");
  assert.equal(i.decideIcon(Buffer.from("png"), b), "keep");
  assert.equal(i.decideIcon(Buffer.from("old"), b), "rewrite");
});
test("needsExtractFlag", () => {
  assert.equal(i.needsExtractFlag({ resourcesPath: "/tmp/.mount_LapidaXyz/resources", hasLibfuse: false }), false);
  assert.equal(i.needsExtractFlag({ resourcesPath: "/tmp/appimage_extracted_x/resources", hasLibfuse: false }), true);
  assert.equal(i.needsExtractFlag({ resourcesPath: "/tmp/appimage_extracted_x/resources", hasLibfuse: true }), false);
});

test("ensureIntegration: ciclo completo em XDG temporario", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lap-int-"));
  try {
    const icon = path.join(tmp, "icon.png");
    fs.writeFileSync(icon, "PNG1");
    const calls = [];
    const base = {
      appImage: AI, resourcesPath: "/tmp/.mount_abc/resources", iconSources: [path.join(tmp, "nope.png"), icon],
      env: { XDG_DATA_HOME: path.join(tmp, "data") }, home: tmp, hasLibfuse: true, run: (c, a) => calls.push(c),
    };
    const entry = path.join(tmp, "data/applications/lapidare.desktop");
    const ic = path.join(tmp, "data/icons/hicolor/512x512/apps/lapidare.png");
    assert.deepEqual(i.ensureIntegration(base), { entry: "create", icon: "create" });
    assert.equal(fs.readFileSync(ic, "utf8"), "PNG1");
    assert.deepEqual(calls, ["update-desktop-database", "gtk-update-icon-cache"]);
    // idempotente
    calls.length = 0;
    const mtime = fs.statSync(entry).mtimeMs;
    assert.deepEqual(i.ensureIntegration(base), { entry: "keep", icon: "keep" });
    assert.equal(fs.statSync(entry).mtimeMs, mtime);
    assert.deepEqual(calls, []);
    // AppImage movido
    assert.equal(i.ensureIntegration({ ...base, appImage: "/novo/L.AppImage" }).entry, "rewrite");
    assert.match(fs.readFileSync(entry, "utf8"), /Exec="\/novo\/L\.AppImage" %U/);
    // do usuario: intocado (e icone tambem)
    fs.writeFileSync(entry, "[Desktop Entry]\nName=Meu\n");
    fs.writeFileSync(ic, "USER");
    assert.equal(i.ensureIntegration(base).entry, "skip");
    assert.equal(fs.readFileSync(entry, "utf8"), "[Desktop Entry]\nName=Meu\n");
    assert.equal(fs.readFileSync(ic, "utf8"), "USER");
    // opt-out
    fs.rmSync(entry);
    assert.equal(i.ensureIntegration({ ...base, env: { ...base.env, LAPIDARE_NO_DESKTOP_INTEGRATION: "1" } }).entry, "disabled");
    assert.equal(fs.existsSync(entry), false);
    // nunca lanca
    assert.ok(i.ensureIntegration({ ...base, appImage: "relativo" }).error);
    assert.deepEqual(fs.readdirSync(path.dirname(entry)).filter((f) => f.includes(".tmp-")), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
