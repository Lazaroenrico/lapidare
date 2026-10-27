#!/usr/bin/env bash
# Instala o AppImage para o usuario atual: ~/Applications + icone + lapidare.desktop, para que
# launchers (Omarchy, GNOME, KDE...) o listem. `--uninstall` remove os tres.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
TARGET="$HOME/Applications/Lapidare.AppImage"
ICON="$DATA/icons/hicolor/512x512/apps/lapidare.png"
ENTRY="$DATA/applications/lapidare.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$TARGET" "$ICON" "$ENTRY"
  update-desktop-database "$DATA/applications" 2>/dev/null || true
  echo "Lapidare removido do launcher."
  exit 0
fi

shopt -s nullglob
built=("$ROOT"/desktop/dist/Lapidare-*-x86_64.AppImage)
[[ ${#built[@]} -eq 1 ]] || { echo "Rode 'make desktop' antes (AppImage nao encontrado em desktop/dist)." >&2; exit 1; }

mkdir -p "$(dirname "$TARGET")" "$(dirname "$ICON")" "$(dirname "$ENTRY")"
install -m 755 "${built[0]}" "$TARGET"
install -m 644 "$ROOT/desktop/build-resources/icon.png" "$ICON"

# Sem libfuse2 (comum em distros novas) o AppImage nao monta; extrair e rodar funciona sempre.
args=""
ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2' || args=" --appimage-extract-and-run"

cat >"$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Lapidare
Comment=Estude com um tutor que mede, planeja e ensina
Exec="$TARGET"$args %U
Icon=lapidare
Terminal=false
Categories=Education;
StartupWMClass=lapidare
DESKTOP
update-desktop-database "$DATA/applications" 2>/dev/null || true
gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true
echo "Lapidare instalado: $TARGET"
echo "Atalho: $ENTRY"
