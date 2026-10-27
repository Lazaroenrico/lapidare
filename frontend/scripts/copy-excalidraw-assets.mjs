// Copies Excalidraw's bundled fonts so the canvas never falls back to the esm.sh CDN.
// Usage: node scripts/copy-excalidraw-assets.mjs [destDir]
//   no arg -> public/excalidraw (served by `next dev` and copied into the export by Next)
//   "out"  -> out/excalidraw (after a static export)
// The page sets window.EXCALIDRAW_ASSET_PATH = "/excalidraw/", so fonts live in <dest>/fonts.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const dest = resolve(root, process.argv[2] ? join(process.argv[2], "excalidraw") : "public/excalidraw");

if (!existsSync(source)) {
  console.error(`Excalidraw fonts not found at ${source}; run npm install first.`);
  process.exit(1);
}
rmSync(join(dest, "fonts"), { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(source, join(dest, "fonts"), { recursive: true });
console.log(`Excalidraw fonts copied to ${join(dest, "fonts")}`);
