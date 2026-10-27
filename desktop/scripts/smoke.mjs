#!/usr/bin/env node
// Sobe o python empacotado como o main.cjs e confere as rotas basicas.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const policy = require(path.join(here, "..", "policy.cjs"));

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? path.resolve(args[i + 1]) : def;
};
const pyDir = opt("--python", path.join(here, "..", "build", "python"));
const webDir = opt("--web", path.join(here, "..", "build", "web"));
const python = path.join(pyDir, "bin", "python3");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lapidare-smoke-"));
const logFile = path.join(tmp, "backend.log");
let child = null;
let exited = false;

function cleanup() {
  if (child && child.pid && !exited) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { cleanup(); process.exit(130); });

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

const failures = [];
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " " + extra : ""}`);
  if (!ok) failures.push(name);
}

async function main() {
  const port = await freePort();
  const secret = crypto.randomBytes(32).toString("hex");
  const base = `http://127.0.0.1:${port}`;
  const env = policy.buildChildEnv(process.env, {
    LEARNHARNESS_PORT: port,
    LEARNHARNESS_STATIC_DIR: webDir,
    LEARNHARNESS_CORS_ORIGINS: base,
    LEARNHARNESS_DESKTOP_SECRET: secret,
    LEARNHARNESS_APP_VERSION: "0.0.0-smoke",
    LEARNHARNESS_ORIG_LD_LIBRARY_PATH: "",
    LEARNHARNESS_VAULT_PATH: path.join(tmp, "vault"),
    HOME: path.join(tmp, "home"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg"),
  });
  fs.mkdirSync(env.HOME, { recursive: true });
  const out = fs.openSync(logFile, "a");
  child = spawn(python, ["-I", "-m", "learnharness.desktop"], { cwd: tmp, env, detached: true, stdio: ["ignore", out, out] });
  child.on("exit", () => { exited = true; });
  const H = { [policy.HEADER]: secret };
  const get = (p, headers) => fetch(base + p, { headers, signal: AbortSignal.timeout(5000) });

  let up = false;
  for (let i = 0; i < 150 && !exited; i++) {
    try { if ((await get("/api/health", H)).status === 200) { up = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    console.error("backend nao subiu; log:\n" + fs.readFileSync(logFile, "utf8").split("\n").slice(-25).join("\n"));
    failures.push("startup");
    return;
  }
  const h = await get("/api/health", H);
  check("health com header 200", h.status === 200);
  check("health sem header 403", (await get("/api/health")).status === 403);
  for (const p of ["/", "/chat/anything"]) {
    const r = await get(p);
    const body = await r.text();
    check(`${p} HTML 200`, r.status === 200 && /<html|<!doctype/i.test(body), `(${r.status})`);
    if (p === "/") {
      const m = body.match(/\/_next\/static\/[^"')\s]+\.(?:js|css)/);
      if (!m) check("asset /_next/static referenciado", false);
      else check(`asset ${m[0]} 200`, (await get(m[0])).status === 200);
    }
  }
  const s = await get("/api/setup/status", H);
  check("/api/setup/status 200", s.status === 200, `(${s.status})`);
}

try {
  if (!fs.existsSync(python)) throw new Error(`python nao encontrado: ${python}`);
  await main();
} catch (e) {
  console.error(e);
  failures.push("excecao");
} finally {
  cleanup();
}
if (failures.length) { console.error("smoke FALHOU: " + failures.join(", ")); process.exit(1); }
console.log("smoke ok");
