"use strict";
// Politicas puras da casca Electron (sem import de electron).

const HEADER = "x-lapidare-desktop";

function parse(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

function sameOrigin(u, appOrigin) {
  return u !== null && u.origin !== "null" && u.origin === appOrigin;
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function shouldInjectSecret(args) {
  try {
    const { url, appOrigin, webContentsId, trustedIds, isMainFrame } = args;
    if (isMainFrame !== true) return false;
    const u = parse(url);
    if (!u || !sameOrigin(u, appOrigin)) return false;
    if (u.username || u.password) return false;
    if (!isApiPath(u.pathname)) return false;
    const ids = trustedIds instanceof Set ? trustedIds : new Set(trustedIds || []);
    return webContentsId !== undefined && webContentsId !== null && ids.has(webContentsId);
  } catch {
    return false;
  }
}

function classifyOpen(url, appOrigin) {
  const u = parse(url);
  if (!u) return "deny";
  if (sameOrigin(u, appOrigin)) return u.username || u.password ? "deny" : "child";
  if (["http:", "https:", "obsidian:"].includes(u.protocol)) return "external";
  return "deny";
}

function classifyNavigate(url, appOrigin) {
  const u = parse(url);
  if (!u) return "deny";
  if (sameOrigin(u, appOrigin)) return u.username || u.password ? "deny" : "allow";
  if (["http:", "https:", "obsidian:"].includes(u.protocol)) return "external";
  return "deny";
}

const STRIP = [/^ELECTRON_/, /^APPDIR$/, /^LD_LIBRARY_PATH$/, /^PYTHONHOME$/, /^PYTHONPATH$/];

function buildChildEnv(parentEnv, extras) {
  const env = {};
  for (const [k, v] of Object.entries(parentEnv || {})) {
    if (v === undefined) continue;
    if (STRIP.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extras || {})) {
    if (v === undefined || v === null) continue;
    env[k] = String(v);
  }
  return env;
}

module.exports = { HEADER, shouldInjectSecret, classifyOpen, classifyNavigate, buildChildEnv };
