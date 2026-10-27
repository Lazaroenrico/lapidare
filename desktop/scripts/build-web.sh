#!/usr/bin/env bash
# Gera a UI estatica (frontend/out) e copia para desktop/build/web.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
(cd "$ROOT/frontend" && npm run export)
rm -rf "$ROOT/desktop/build/web"
mkdir -p "$ROOT/desktop/build"
cp -r "$ROOT/frontend/out" "$ROOT/desktop/build/web"
echo "web: $(du -sh "$ROOT/desktop/build/web" | cut -f1)"

# O webpack embute file:///<repo>/... (new URL(..., import.meta.url)) em alguns chunks de node_modules.
# Sao URLs mortas no navegador; troca o prefixo do repo para nao vazar o caminho do dev no bundle.
grep -rlF "$ROOT" "$ROOT/desktop/build/web" 2>/dev/null | xargs -r sed -i "s#${ROOT}#/lapidare-src#g"
