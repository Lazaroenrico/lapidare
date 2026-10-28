"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../policy.cjs");

const O = "http://127.0.0.1:5000";
const base = { appOrigin: O, webContentsId: 1, trustedIds: new Set([1]), isMainFrame: true };

test("inject: caminho feliz", () => {
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/api/health" }), true);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/api" }), true);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/api/events?x=1" }), true);
});
test("inject: recusas", () => {
  assert.equal(p.shouldInjectSecret({ ...base, url: "http://127.0.0.1:5001/api/x" }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: "https://evil.com/api/x" }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/apix" }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/chat" }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: "http://u:p@127.0.0.1:5000/api/x" }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: "http://u@127.0.0.1:5000/api/x" }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/api/x", webContentsId: 2 }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/api/x", isMainFrame: false }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/api/x", webContentsId: undefined }), false);
});
test("inject: falha fechada", () => {
  assert.equal(p.shouldInjectSecret({ ...base, url: "::nao-url" }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: undefined }), false);
  assert.equal(p.shouldInjectSecret({ ...base, url: O + "/api/x", trustedIds: undefined }), false);
  assert.equal(p.shouldInjectSecret(undefined), false);
});
test("inject: trustedIds como array", () => {
  assert.equal(p.shouldInjectSecret({ ...base, trustedIds: [1], url: O + "/api/x" }), true);
});
test("classifyOpen", () => {
  assert.equal(p.classifyOpen(O + "/demo", O), "child");
  assert.equal(p.classifyOpen("https://a.com", O), "external");
  assert.equal(p.classifyOpen("http://a.com", O), "external");
  assert.equal(p.classifyOpen("obsidian://open?vault=x", O), "external");
  assert.equal(p.classifyOpen("file:///etc/passwd", O), "deny");
  assert.equal(p.classifyOpen("javascript:alert(1)", O), "deny");
  assert.equal(p.classifyOpen("http://u:p@127.0.0.1:5000/", O), "deny");
  assert.equal(p.classifyOpen("lixo", O), "deny");
  assert.equal(p.classifyOpen("about:blank", O), "deny");
});
test("classifyNavigate", () => {
  assert.equal(p.classifyNavigate(O + "/chat/1", O), "allow");
  assert.equal(p.classifyNavigate("https://a.com", O), "external");
  assert.equal(p.classifyNavigate("obsidian://x", O), "external");
  assert.equal(p.classifyNavigate("file:///x", O), "deny");
  assert.equal(p.classifyNavigate("http://u:p@127.0.0.1:5000/", O), "deny");
  assert.equal(p.classifyNavigate("lixo", O), "deny");
});
test("buildChildEnv", () => {
  const env = p.buildChildEnv(
    { A: "1", ELECTRON_RUN_AS_NODE: "1", ELECTRON_X: "2", APPDIR: "/x", LD_LIBRARY_PATH: "/l", PYTHONHOME: "h", PYTHONPATH: "p", PATH: "/old" },
    { PATH: "/new", LEARNHARNESS_PORT: 80, SKIP: undefined },
  );
  assert.deepEqual(env, { A: "1", PATH: "/new", LEARNHARNESS_PORT: "80" });
  assert.deepEqual(p.buildChildEnv(undefined, undefined), {});
});

test("allowPermission", () => {
  const d = (x) => ({ requestingUrl: O + "/", ...x });
  assert.equal(p.allowPermission("media", d({ mediaTypes: ["audio"] }), O), true);
  assert.equal(p.allowPermission("media", d({}), O), true);
  assert.equal(p.allowPermission("media", d({ mediaType: "audio" }), O), true);
  assert.equal(p.allowPermission("media", { securityOrigin: O + "/" }, O), true);
  assert.equal(p.allowPermission("media", d({ mediaTypes: ["video"] }), O), false);
  assert.equal(p.allowPermission("media", d({ mediaTypes: ["audio", "video"] }), O), false);
  assert.equal(p.allowPermission("media", d({ mediaType: "video" }), O), false);
  assert.equal(p.allowPermission("media", { requestingUrl: "https://a.com/" }, O), false);
  assert.equal(p.allowPermission("media", { mediaTypes: ["audio"] }, O), false);
  assert.equal(p.allowPermission("media", undefined, O), false);
  for (const perm of ["geolocation", "notifications", "clipboard-read", "display-capture", "openExternal", "fullscreen"])
    assert.equal(p.allowPermission(perm, d({}), O), false);
});
test("isAppSender", () => {
  assert.equal(p.isAppSender(O + "/x", O), true);
  assert.equal(p.isAppSender("https://a.com/", O), false);
  assert.equal(p.isAppSender("http://u:p@127.0.0.1:5000/", O), false);
  assert.equal(p.isAppSender(undefined, O), false);
  assert.equal(p.isAppSender("file:///x", O), false);
});
test("isReleaseUrl", () => {
  const R = "https://github.com/Lazaroenrico/lapidare/releases";
  assert.equal(p.isReleaseUrl(R), true);
  assert.equal(p.isReleaseUrl(R + "/"), true);
  assert.equal(p.isReleaseUrl(R + "/tag/v1.2.3"), true);
  assert.equal(p.isReleaseUrl(R + "/tag/v1.2.3-rc.1"), true);
  assert.equal(p.isReleaseUrl(R + "/tag/"), false);
  assert.equal(p.isReleaseUrl(R + "/tag/v1/../../x"), false);
  assert.equal(p.isReleaseUrl(R + "/download/v1/x.AppImage"), false);
  assert.equal(p.isReleaseUrl("http://github.com/Lazaroenrico/lapidare/releases"), false);
  assert.equal(p.isReleaseUrl("https://github.com/other/lapidare/releases"), false);
  assert.equal(p.isReleaseUrl("https://github.com.evil.com/Lazaroenrico/lapidare/releases"), false);
  assert.equal(p.isReleaseUrl("https://u:p@github.com/Lazaroenrico/lapidare/releases"), false);
  assert.equal(p.isReleaseUrl(R + "?x=1"), false);
  assert.equal(p.isReleaseUrl("lixo"), false);
  assert.equal(p.isReleaseUrl(undefined), false);
});
