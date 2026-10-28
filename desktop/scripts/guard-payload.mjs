#!/usr/bin/env node
// Falha o build se desktop/build contiver segredos, dados de usuario ou caminhos do dev.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const offenders = [];
const BAD_DIRS = new Set([".harness", ".gemini", ".agents"]);
const BAD_FILE = (n) => n === "secrets.json" || n === "active-vault" || n.startsWith(".env") || n.endsWith(".jsonl") || n.endsWith(".sqlite");

const needles = [os.homedir()];
try {
  const v = fs.readFileSync(path.join(os.homedir(), ".config", "learnharness", "active-vault"), "utf8").trim();
  if (v) needles.push(v);
} catch {}
const needleBufs = [...new Set(needles.filter((n) => n.length > 3))].map((n) => Buffer.from(n));

function isText(buf) {
  return !buf.subarray(0, 4096).includes(0);
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (BAD_DIRS.has(e.name)) offenders.push(`dir proibido: ${p}`);
      else walk(p);
    } else if (e.isFile()) {
      if (BAD_FILE(e.name)) offenders.push(`arquivo proibido: ${p}`);
      const st = fs.statSync(p);
      if (st.size === 0 || st.size > 2 * 1024 * 1024) continue;
      const buf = fs.readFileSync(p);
      if (!isText(buf)) continue;
      // SBOMs de wheels guardam o caminho de build do upstream, que na CI coincide com o HOME do runner.
      if (path.basename(dir) === "sboms" && path.dirname(dir).endsWith(".dist-info")) continue;
      for (const n of needleBufs) if (buf.includes(n)) offenders.push(`contem ${n.toString()}: ${p}`);
    }
  }
}

if (!fs.existsSync(root)) {
  console.error(`guard: ${root} nao existe`);
  process.exit(1);
}
walk(root);

function hasMd(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasMd(path.join(dir, e.name)) : e.name.endsWith(".md")));
}
const prompts = path.join(root, "python", "lib", "python3.12", "site-packages", "learnharness", "prompts");
if (!hasMd(prompts)) offenders.push(`faltando: prompts/**/*.md em ${prompts}`);
if (fs.existsSync(path.join(root, "web")) && !fs.existsSync(path.join(root, "web", "index.html"))) offenders.push("faltando: build/web/index.html");
if (!fs.existsSync(path.join(root, "web"))) offenders.push("faltando: build/web");

if (offenders.length) {
  console.error("guard-payload FALHOU:\n" + offenders.map((o) => "  - " + o).join("\n"));
  process.exit(1);
}
console.log("guard-payload ok");
