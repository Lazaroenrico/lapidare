"use strict";
// Auto-integracao do AppImage ao menu de apps (Linux). Sem import de electron: testavel com node puro.
// A parte pura (texto, decisao, marcador) vem primeiro; o wrapper de I/O no fim.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MARKER = "X-Lapidare-Managed=true";
const COMMENT = "Estude com um tutor que mede, planeja e ensina";

// Aspas do campo Exec (spec freedesktop): dentro de "..." escapa \ " ` $ com barra; % vira %%.
function quoteExec(p) {
  return '"' + String(p).replace(/[\\"`$]/g, "\\$&").replace(/%/g, "%%") + '"';
}

function buildEntry({ appImage, extractAndRun }) {
  if (typeof appImage !== "string" || !path.isAbsolute(appImage) || /[\r\n\0]/.test(appImage)) {
    throw new Error("caminho do AppImage invalido");
  }
  const flag = extractAndRun ? " --appimage-extract-and-run" : "";
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Lapidare",
    `Comment=${COMMENT}`,
    `Exec=${quoteExec(appImage)}${flag} %U`,
    "Icon=lapidare",
    "Terminal=false",
    "Categories=Education;",
    "StartupWMClass=lapidare",
    MARKER,
    "",
  ].join("\n");
}

function isManaged(text) {
  return typeof text === "string" && text.split(/\r?\n/).some((l) => l.trim() === MARKER);
}

// existing: texto atual ou null (ausente). Retorna "create" | "rewrite" | "keep" | "skip".
function decideEntry(existing, desired) {
  if (existing === null || existing === undefined) return "create";
  if (!isManaged(existing)) return "skip"; // do usuario: nunca sobrescrever
  return existing === desired ? "keep" : "rewrite";
}

function decideIcon(existing, desired) {
  if (!existing) return "create";
  return Buffer.compare(existing, desired) === 0 ? "keep" : "rewrite";
}

// AppImage montado (resourcesPath em .mount_*) dispensa a flag; senao exige libfuse.so.2.
function needsExtractFlag({ resourcesPath, hasLibfuse }) {
  if (/[\\/]\.mount_[^\\/]+[\\/]/.test(String(resourcesPath || ""))) return false;
  return !hasLibfuse;
}

function dataHome(env, home) {
  return env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
}

const LIB_DIRS = [
  "/usr/lib", "/usr/lib64", "/lib", "/lib64",
  "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu",
  "/usr/lib/i386-linux-gnu", "/usr/local/lib",
];

function hasLibfuse2(dirs = LIB_DIRS) {
  return dirs.some((d) => {
    try {
      return fs.existsSync(path.join(d, "libfuse.so.2"));
    } catch {
      return false;
    }
  });
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

function writeAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function runBestEffort(cmd, args, log) {
  try {
    execFile(cmd, args, { timeout: 5000 }, (err) => {
      if (err && err.code !== "ENOENT") log(`integracao: ${cmd} falhou: ${err.message}`);
    });
  } catch (e) {
    log(`integracao: ${cmd} indisponivel: ${e.message}`);
  }
}

/**
 * Garante lapidare.desktop + icone apontando para o AppImage atual. Nunca lanca.
 * opts: { appImage, resourcesPath, iconSources: [paths], env, home, log, hasLibfuse?, run? }
 */
function ensureIntegration(opts) {
  const log = opts.log || (() => {});
  const result = { entry: "none", icon: "none" };
  try {
    const env = opts.env || process.env;
    if (env.LAPIDARE_NO_DESKTOP_INTEGRATION === "1") return { ...result, entry: "disabled" };
    const data = dataHome(env, opts.home);
    const appsDir = path.join(data, "applications");
    const hicolor = path.join(data, "icons", "hicolor");
    const entryFile = path.join(appsDir, "lapidare.desktop");
    const iconFile = path.join(hicolor, "512x512", "apps", "lapidare.png");
    const run = opts.run || ((c, a) => runBestEffort(c, a, log));

    const extractAndRun = needsExtractFlag({
      resourcesPath: opts.resourcesPath,
      hasLibfuse: opts.hasLibfuse === undefined ? hasLibfuse2() : opts.hasLibfuse,
    });
    const desired = buildEntry({ appImage: opts.appImage, extractAndRun });
    const cur = readOrNull(entryFile);
    result.entry = decideEntry(cur === null ? null : cur.toString("utf8"), desired);
    if (result.entry === "skip") log("integracao: lapidare.desktop existente nao e gerenciado; mantido");

    // O icone so e tocado quando a entrada e nossa (ou nova).
    if (result.entry !== "skip") {
      let iconData = null;
      for (const src of opts.iconSources || []) {
        try {
          iconData = fs.readFileSync(src);
          break;
        } catch {}
      }
      if (iconData) {
        result.icon = decideIcon(readOrNull(iconFile), iconData);
        if (result.icon !== "keep") writeAtomic(iconFile, iconData, 0o644);
      } else {
        log("integracao: icone-fonte nao encontrado");
      }
      if (result.entry === "create" || result.entry === "rewrite") writeAtomic(entryFile, desired, 0o644);
    }

    if (result.entry === "create" || result.entry === "rewrite") run("update-desktop-database", [appsDir]);
    if (result.icon === "create" || result.icon === "rewrite") run("gtk-update-icon-cache", ["-q", "-t", hicolor]);
  } catch (e) {
    log(`integracao falhou: ${e && e.message}`);
    result.error = String((e && e.message) || e);
  }
  return result;
}

module.exports = { MARKER, quoteExec, buildEntry, isManaged, decideEntry, decideIcon, needsExtractFlag, dataHome, hasLibfuse2, ensureIntegration };
