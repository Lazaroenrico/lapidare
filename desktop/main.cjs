"use strict";
const { app, BrowserWindow, Menu, dialog, session, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const policy = require("./policy.cjs");

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
  const fallback = dedupe(`${process.env.PATH || ""}:${path.join(os.homedir(), ".local", "bin")}`);
  const shellBin = process.env.SHELL || "/bin/sh";
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

const WEB_PREFS = { sandbox: true, contextIsolation: true, nodeIntegration: false };

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
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#1a1430",
    title: "Lapidare",
    icon: path.join(__dirname, "build-resources", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { ...WEB_PREFS },
  });
  trust(mainWindow.webContents);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(url);
}

function setupUpdater() {
  if (!process.env.APPIMAGE || !app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoInstallOnAppQuit = true;
    if (process.env.LAPIDARE_UPDATE_FEED) autoUpdater.setFeedURL({ provider: "generic", url: process.env.LAPIDARE_UPDATE_FEED });
    autoUpdater.on("error", (e) => log(`updater: ${e && e.message}`));
    autoUpdater.on("update-downloaded", async (info) => {
      try {
        const { response } = await dialog.showMessageBox(mainWindow || undefined, {
          type: "info",
          buttons: ["Reiniciar agora", "Depois"],
          defaultId: 0,
          cancelId: 1,
          title: "Lapidare",
          message: `A versão ${info.version} do Lapidare está pronta.`,
        });
        if (response === 0) {
          quitting = true;
          killBackend();
          autoUpdater.quitAndInstall();
        }
      } catch (e) {
        log(`updater dialog: ${e.message}`);
      }
    });
    autoUpdater.checkForUpdates().catch((e) => log(`updater check: ${e.message}`));
  } catch (e) {
    log(`updater indisponivel: ${e.message}`);
  }
}

function quit() {
  quitting = true;
  killBackend();
  app.quit();
}

async function boot() {
  setupLog();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ label: "Editar", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] }]),
  );
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
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => quit());
  app.whenReady().then(boot).catch((e) => {
    log(`boot falhou: ${e && e.stack}`);
    dialog.showErrorBox("Lapidare", String((e && e.message) || e));
    quit();
  });
}
