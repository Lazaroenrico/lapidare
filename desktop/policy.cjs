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

// Permissoes: so o microfone (audio) para o ditado, e so a partir da origem do app.
function allowPermission(permission, details, appOrigin) {
  try {
    if (permission !== "media") return false;
    const d = details || {};
    if (Array.isArray(d.mediaTypes) && !d.mediaTypes.every((t) => t === "audio")) return false;
    if (typeof d.mediaType === "string" && d.mediaType !== "audio") return false;
    const u = parse(d.requestingUrl || d.securityOrigin || d.requestingOrigin);
    if (!sameOrigin(u, appOrigin) || u.username || u.password) return false;
    return true;
  } catch {
    return false;
  }
}

// Frame remetente de um IPC: precisa ser a origem do app (sem credenciais).
function isAppSender(url, appOrigin) {
  const u = parse(url);
  return sameOrigin(u, appOrigin) && !u.username && !u.password;
}

// openRelease: somente a pagina de releases do repo ou uma tag dele.
const RELEASES_PATH = "/Lazaroenrico/lapidare/releases";
function isReleaseUrl(url) {
  const u = parse(url);
  if (!u || u.protocol !== "https:" || u.hostname !== "github.com" || u.port) return false;
  if (u.username || u.password || u.search || u.hash) return false;
  const path = u.pathname.replace(/\/$/, "");
  if (path === RELEASES_PATH) return true;
  const prefix = RELEASES_PATH + "/tag/";
  return path.startsWith(prefix) && /^[A-Za-z0-9._+-]{1,64}$/.test(path.slice(prefix.length));
}

module.exports = { HEADER, shouldInjectSecret, classifyOpen, classifyNavigate, buildChildEnv, allowPermission, isAppSender, isReleaseUrl };
