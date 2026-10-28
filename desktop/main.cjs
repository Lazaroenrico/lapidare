"use strict";
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, systemPreferences } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const policy = require("./policy.cjs");
const integration = require("./integration.cjs");

const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const DEV_URL = process.env.LAPIDARE_DEV_URL || "";
const DEV_SECRET = process.env.LAPIDARE_DEV_SECRET || "";
const MAX_LOG = 5 * 1024 * 1024;

let child = null;
let childExit = null; // { code, signal } quando o backend sair
let mainWindow = null;
let appOrigin = "";
let secret = "";
let quitting = false;
let killTimer = null;
let logPath = "";
const trustedIds = new Set();

function log(msg) {
  try {
    if (logPath) fs.appendFileSync(logPath, `[${new Date().toISOString()}] [main] ${msg}\n`);
  } catch {}
}

function setupLog() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, "main.log");
  try {
    if (fs.statSync(logPath).size > MAX_LOG) fs.renameSync(logPath, logPath + ".1");
  } catch {}
}

function tailLog(lines = 15) {
  try {
    const buf = fs.readFileSync(logPath, "utf8").split("\n");
    return buf.slice(-lines - 1).join("\n").trim();
  } catch {
    return "(sem log)";
  }
}

function dedupe(p) {
  return [...new Set(p.split(":").filter(Boolean))].join(":");
}

function resolvePath() {
  const extra = IS_MAC ? ":/opt/homebrew/bin:/usr/local/bin" : "";
  const fallback = dedupe(`${process.env.PATH || ""}:${path.join(os.homedir(), ".local", "bin")}${extra}`);
  const shellBin = process.env.SHELL || (IS_MAC ? "/bin/zsh" : "/bin/sh");
  return new Promise((resolve) => {
    try {
      execFile(shellBin, ["-ilc", 'printf %s "$PATH"'], { timeout: 3000, encoding: "utf8" }, (err, out) => {
        if (err || !out || !out.trim()) return resolve(fallback);
        // ruido de rc files pode vir antes: usa a ultima linha.
        const last = out.trim().split("\n").pop();
        resolve(dedupe(`${last}:${fallback}`));
      });
    } catch {
      resolve(fallback);
    }
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startBackend(port, pathEnv) {
  const python = path.join(process.resourcesPath, "python", "bin", "python3");
  const env = policy.buildChildEnv(process.env, {
    LEARNHARNESS_PORT: port,
    LEARNHARNESS_STATIC_DIR: path.join(process.resourcesPath, "web"),
    LEARNHARNESS_CORS_ORIGINS: `http://127.0.0.1:${port}`,
    LEARNHARNESS_DESKTOP_SECRET: secret,
    LEARNHARNESS_APP_VERSION: app.getVersion(),
    LEARNHARNESS_ORIG_LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || "",
    PATH: pathEnv,
  });
  const out = fs.openSync(logPath, "a");
  child = spawn(python, ["-I", "-m", "learnharness.desktop"], {
    cwd: app.getPath("userData"),
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  child.on("error", (e) => {
    log(`falha ao iniciar backend: ${e.message}`);
    childExit = { code: -1, signal: null };
  });
  child.on("exit", (code, signal) => {
    childExit = { code, signal };
    log(`backend saiu code=${code} signal=${signal}`);
    if (!quitting && mainWindow) {
      dialog.showErrorBox("Lapidare", "O servidor interno do Lapidare encerrou inesperadamente.\n\n" + tailLog());
      app.quit();
    }
  });
  log(`backend pid=${child.pid} porta=${port}`);
}

function killBackend() {
  if (!child || child.pid === undefined || childExit) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  if (!killTimer) {
    const pid = child.pid;
    killTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 6000);
    killTimer.unref();
  }
}

async function waitHealthy(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (childExit) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { [policy.HEADER]: secret },
        signal: AbortSignal.timeout(1500),
      });
      if (r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function failStartup() {
  const code = childExit ? childExit.code : null;
  let msg;
  if (code === 75) msg = "O vault já está aberto em outra instância do Lapidare. Feche a outra janela e tente de novo.";
  else if (code === 76)
    msg =
      "Os dados do vault foram gravados por uma versão mais nova do Lapidare. Atualize o app ou restaure uma cópia em .harness/backups.";
  else msg = "Não foi possível iniciar o servidor do Lapidare.\n\n" + tailLog();
  dialog.showErrorBox("Lapidare", msg);
  quit();
}

const WEB_PREFS = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  preload: path.join(__dirname, "preload.cjs"),
  additionalArguments: [`--lapidare-version=${app.getVersion()}`],
};

function trust(wc) {
  trustedIds.add(wc.id);
  wc.once("destroyed", () => trustedIds.delete(wc.id));
  wc.on("will-navigate", (e, url) => {
    const c = policy.classifyNavigate(url, appOrigin);
    if (c === "allow") return;
    e.preventDefault();
    if (c === "external") shell.openExternal(url).catch(() => {});
  });
  wc.setWindowOpenHandler(({ url }) => {
    const c = policy.classifyOpen(url, appOrigin);
    if (c === "external") shell.openExternal(url).catch(() => {});
    if (c === "child") return { action: "allow", overrideBrowserWindowOptions: { backgroundColor: "#1a1430", webPreferences: { ...WEB_PREFS } } };
    return { action: "deny" };
  });
  wc.on("did-create-window", (win) => trust(win.webContents));
}

function setupSession() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = { ...details.requestHeaders };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === policy.HEADER) delete headers[k];
    const inject = policy.shouldInjectSecret({
      url: details.url,
      appOrigin,
      webContentsId: details.webContentsId,
      trustedIds,
      isMainFrame: details.resourceType !== "subFrame" && (details.frame ? details.frame.parent === null : true),
    });
    const sec = DEV_URL ? DEV_SECRET : secret;
    if (inject && sec) headers[policy.HEADER] = sec;
    cb({ requestHeaders: headers });
  });
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (!policy.allowPermission(permission, details, appOrigin)) return cb(false);
    if (!IS_MAC) return cb(true);
    systemPreferences.askForMediaAccess("microphone").then(cb, () => cb(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const d = { ...(details || {}) };
    if (!d.requestingUrl && !d.securityOrigin) d.requestingOrigin = requestingOrigin;
    if (!policy.allowPermission(permission, d, appOrigin)) return false;
    return !IS_MAC || systemPreferences.getMediaAccessStatus("microphone") !== "denied";
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#1a1430",
    title: "Lapidare",
    ...(IS_LINUX ? { icon: path.join(__dirname, "build-resources", "icon.png") } : {}),
    autoHideMenuBar: true,
    webPreferences: { ...WEB_PREFS },
  });
  trust(mainWindow.webContents);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(url);
}

// Estado de updates. AppImage: "auto" (baixa e instala ao sair). deb/rpm/mac: "notify"
// (autoDownload=false): o electron-updater escolheria Deb/RpmUpdater (pkexec) ou MacUpdater
// (exige app assinado), entao so avisamos e abrimos a pagina de releases.
const SIX_H = 6 * 60 * 60 * 1000;
const CH = { get: "lapidare:updates:get", state: "lapidare:updates:state", check: "lapidare:updates:check", restart: "lapidare:updates:restart", open: "lapidare:updates:open-release", auto: "lapidare:updates:set-auto" };
let updState = { status: "unsupported", mode: "notify", autoUpdate: true };
let updater = null;
let updTimer = null;

function updatesFile() {
  return path.join(app.getPath("userData"), "updates.json");
}
function loadAuto() {
  try {
    return JSON.parse(fs.readFileSync(updatesFile(), "utf8")).autoUpdate !== false;
  } catch {
    return true;
  }
}
function saveAuto(on) {
  try {
    fs.writeFileSync(updatesFile(), JSON.stringify({ autoUpdate: on }));
  } catch (e) {
    log(`updates.json: ${e.message}`);
  }
}
function setUpd(patch) {
  updState = { ...updState, ...patch };
  for (const k of ["version", "error"]) if (updState[k] === undefined) delete updState[k];
  for (const w of BrowserWindow.getAllWindows()) {
    if (trustedIds.has(w.webContents.id)) w.webContents.send(CH.state, updState);
  }
}
async function runCheck(manual) {
  if (!updater || ["staged", "checking", "downloading"].includes(updState.status)) return;
  if (!manual && !updState.autoUpdate) return;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    log(`updater check: ${e.message}`);
    setUpd({ status: "error", error: String((e && e.message) || e).slice(0, 200) });
  }
}
function scheduleCheck() {
  updTimer = setTimeout(async () => {
    await runCheck(false);
    scheduleCheck();
  }, SIX_H);
  updTimer.unref();
}
function fromApp(e) {
  const url = e.senderFrame && e.senderFrame.url;
  return trustedIds.has(e.sender.id) && policy.isAppSender(url, appOrigin);
}
function setupUpdateIpc() {
  const guard = (fn) => async (e, ...a) => {
    if (!fromApp(e)) throw new Error("origem nao autorizada");
    return fn(...a);
  };
  ipcMain.handle(CH.get, guard(() => updState));
  ipcMain.handle(CH.check, guard(() => runCheck(true)));
  ipcMain.handle(CH.open, guard(async () => {
    const url = updState.version
      ? `https://github.com/Lazaroenrico/lapidare/releases/tag/v${updState.version}`
      : "https://github.com/Lazaroenrico/lapidare/releases";
    const target = policy.isReleaseUrl(url) ? url : "https://github.com/Lazaroenrico/lapidare/releases";
    if (policy.isReleaseUrl(target)) await shell.openExternal(target);
  }));
  ipcMain.handle(CH.auto, guard((on) => {
    saveAuto(on === true);
    setUpd({ autoUpdate: on === true });
  }));
  ipcMain.handle(CH.restart, guard(() => {
    if (updState.status !== "staged" || !updater) return;
    quitting = true;
    killBackend();
    updater.quitAndInstall();
  }));
}

function setupUpdater() {
  const autoUpdate = loadAuto();
  const auto = IS_LINUX && !!process.env.APPIMAGE;
  updState = { status: "unsupported", mode: auto ? "auto" : "notify", autoUpdate };
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    updater = autoUpdater;
    autoUpdater.autoDownload = auto;
    autoUpdater.autoInstallOnAppQuit = auto;
    if (process.env.LAPIDARE_UPDATE_FEED) autoUpdater.setFeedURL({ provider: "generic", url: process.env.LAPIDARE_UPDATE_FEED });
    autoUpdater.on("checking-for-update", () => setUpd({ status: "checking", error: undefined }));
    autoUpdater.on("update-available", (i) => setUpd({ status: auto ? "downloading" : "available", version: i.version }));
    autoUpdater.on("update-not-available", () => setUpd({ status: "idle", version: undefined }));
    autoUpdater.on("download-progress", () => {
      if (updState.status !== "downloading") setUpd({ status: "downloading" });
    });
    autoUpdater.on("update-downloaded", (i) => setUpd({ status: "staged", version: i.version }));
    autoUpdater.on("error", (e) => {
      log(`updater: ${e && e.message}`);
      setUpd({ status: "error", error: String((e && e.message) || e).slice(0, 200) });
    });
    setUpd({ status: "idle" });
    runCheck(false);
    scheduleCheck();
  } catch (e) {
    log(`updater indisponivel: ${e.message}`);
    setUpd({ status: "unsupported" });
  }
}

function quit() {
  quitting = true;
  killBackend();
  app.quit();
}

function setupDesktopIntegration() {
  if (!IS_LINUX || !process.env.APPIMAGE || !app.isPackaged) return;
  try {
    const r = integration.ensureIntegration({
      appImage: process.env.APPIMAGE,
      resourcesPath: process.resourcesPath,
      iconSources: [path.join(process.resourcesPath, "icon.png"), path.join(__dirname, "build-resources", "icon.png")],
      env: process.env,
      home: os.homedir(),
      log,
    });
    log(`integracao desktop: entry=${r.entry} icon=${r.icon}`);
  } catch (e) {
    log(`integracao desktop: ${e && e.message}`);
  }
}

async function boot() {
  setupLog();
  setupUpdateIpc();
  setupDesktopIntegration();
  const editMenu = { label: "Editar", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] };
  Menu.setApplicationMenu(Menu.buildFromTemplate(IS_MAC ? [{ role: "appMenu" }, editMenu, { role: "windowMenu" }] : [editMenu]));
  if (DEV_URL) {
    appOrigin = new URL(DEV_URL).origin;
    setupSession();
    createWindow(DEV_URL);
    return;
  }
  secret = crypto.randomBytes(32).toString("hex");
  const [port, pathEnv] = await Promise.all([freePort(), resolvePath()]);
  appOrigin = `http://127.0.0.1:${port}`;
  startBackend(port, pathEnv);
  if (!(await waitHealthy(port))) return failStartup();
  setupSession();
  createWindow(appOrigin + "/");
  mainWindow.webContents.once("did-finish-load", () => log(`ready ${appOrigin}`));
  setupUpdater();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
    killBackend();
  });
  app.on("window-all-closed", () => quit());
  app.on("activate", () => {
    // macOS: clique no Dock sem janela recria a janela, se o backend ainda estiver vivo.
    if (IS_MAC && !quitting && !mainWindow && appOrigin && child && !childExit) createWindow(appOrigin + "/");
  });
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => quit());
  app.whenReady().then(boot).catch((e) => {
    log(`boot falhou: ${e && e.stack}`);
    dialog.showErrorBox("Lapidare", String((e && e.message) || e));
    quit();
  });
}
