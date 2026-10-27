#!/usr/bin/env bash
# Monta desktop/build/python: CPython standalone + dependencias do lock + wheel do learnharness.
set -euo pipefail

PBS_TAG="20261026"
PBS_FILE="cpython-3.12.16+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_FILE//+/%2B}"
PBS_SHA256="6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESK="$ROOT/desktop"
CACHE="$DESK/.cache"
OUT="$DESK/build/python"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$CACHE"
TARBALL="$CACHE/$PBS_FILE"
if [ ! -f "$TARBALL" ] || ! echo "$PBS_SHA256  $TARBALL" | sha256sum -c --quiet - 2>/dev/null; then
  curl -fL --retry 3 -o "$TARBALL.part" "$PBS_URL"
  mv "$TARBALL.part" "$TARBALL"
fi
echo "$PBS_SHA256  $TARBALL" | sha256sum -c -

rm -rf "$OUT" "$DESK/build/.py-extract"
mkdir -p "$DESK/build/.py-extract"
tar -xzf "$TARBALL" -C "$DESK/build/.py-extract"
mv "$DESK/build/.py-extract/python" "$OUT"
rmdir "$DESK/build/.py-extract"

PY="$OUT/bin/python3"
(cd "$ROOT/backend" && uv export --frozen --no-dev --no-emit-project --no-header -o "$TMP/req.txt")
"$PY" -m pip install --no-deps --require-hashes --no-compile --disable-pip-version-check -r "$TMP/req.txt"

(cd "$ROOT/backend" && uv build --wheel -o "$TMP/wheel")
"$PY" -m pip install --no-deps --no-compile --disable-pip-version-check "$TMP"/wheel/learnharness-*.whl

# Remove o que nao serve em runtime (pip por ultimo, depois de usado).
"$PY" -m pip uninstall -y -q pip setuptools wheel 2>/dev/null || true
LIB="$OUT/lib/python3.12"
rm -rf "$LIB/ensurepip" "$LIB/idlelib" "$LIB/tkinter" "$LIB/turtledemo" "$LIB/lib2to3" \
       "$LIB/turtle.py" "$LIB/test" "$LIB/site-packages/pip" "$LIB/site-packages/_distutils_hack"
find "$OUT" -type d \( -name test -o -name tests \) -path "*/lib/python3.12/*" -not -path "*/site-packages/*" -prune -exec rm -rf {} +
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} +
rm -rf "$OUT/lib/tcl"* "$OUT/lib/tk"* "$OUT/lib/itcl"* "$OUT/lib/thread"* 2>/dev/null || true

# Console scripts de pip trazem shebang com caminho absoluto do build e nao servem no app.
find "$OUT/bin" -maxdepth 1 -type f -exec grep -Iq "^#!$OUT" {} \; -delete
# Diretorios de agentes/dados vendorizados por terceiros (o guard proibe estes nomes).
find "$OUT" -type d \( -name .agents -o -name .gemini -o -name .harness \) -prune -exec rm -rf {} +

# site-packages e somente-leitura no AppImage: pre-compila agora.
"$PY" -I -m compileall -q "$LIB"
echo "python: $(du -sh "$OUT" | cut -f1)"
