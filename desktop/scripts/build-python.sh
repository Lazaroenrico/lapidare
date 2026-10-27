#!/usr/bin/env bash
# Monta desktop/build/python: CPython standalone + dependencias do lock + wheel do learnharness.
set -euo pipefail

PBS_TAG="20261026"
PBS_VER="3.12.16"

# Alvo: PY_TARGET explicito (build cruzado) ou o da maquina atual. O pip roda NA maquina de build,
# entao so da para montar o alvo que ela executa (macOS arm64 e x64 usam runners proprios na CI).
if [ -z "${PY_TARGET:-}" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) PY_TARGET="x86_64-unknown-linux-gnu" ;;
    Darwin-arm64) PY_TARGET="aarch64-apple-darwin" ;;
    Darwin-x86_64) PY_TARGET="x86_64-apple-darwin" ;;
    *) echo "plataforma sem CPython embutido: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
fi
case "$PY_TARGET" in
  x86_64-unknown-linux-gnu) PBS_SHA256="6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de" ;;
  aarch64-apple-darwin) PBS_SHA256="fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e" ;;
  x86_64-apple-darwin) PBS_SHA256="a962e47df522889eaa7ff0d6a56203f1079f68aabb65ffdbe8455f362bc769f3" ;;
  *) echo "PY_TARGET desconhecido: $PY_TARGET" >&2; exit 1 ;;
esac
PBS_FILE="cpython-${PBS_VER}+${PBS_TAG}-${PY_TARGET}-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_FILE//+/%2B}"

# macOS nao tem sha256sum.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
sha_ok() { [ -f "$1" ] && [ "$(sha256_of "$1")" = "$PBS_SHA256" ]; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESK="$ROOT/desktop"
CACHE="$DESK/.cache"
OUT="$DESK/build/python"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$CACHE"
TARBALL="$CACHE/$PBS_FILE"
if ! sha_ok "$TARBALL"; then
  curl -fL --retry 3 -o "$TARBALL.part" "$PBS_URL"
  mv "$TARBALL.part" "$TARBALL"
fi
sha_ok "$TARBALL" || { echo "sha256 diferente de $PBS_SHA256: $TARBALL" >&2; exit 1; }
echo "python-build-standalone ok: $PY_TARGET"

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

# site-packages e somente-leitura no app empacotado: pre-compila agora.
"$PY" -I -m compileall -q "$LIB"
echo "python: $(du -sh "$OUT" | cut -f1)"
