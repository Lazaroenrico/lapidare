#!/usr/bin/env bash
# Sobe backend (FastAPI) e frontend (Next.js) juntos.
# Portas configuráveis: BACKEND_PORT (padrão 8000) e FRONTEND_PORT (padrão 3000).
# Vault: LEARNHARNESS_VAULT_PATH (opcional; senão usa o vault ativo registrado no setup).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

port_busy() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if port_busy "$port"; then
    echo "Porta $port já está em uso (veja: ss -ltnp | grep :$port ou docker ps)." >&2
    echo "Use outras portas, ex.: BACKEND_PORT=8100 FRONTEND_PORT=3100 $0" >&2
    exit 1
  fi
done

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# LEARNHARNESS_PORT faz o MCP interno anunciar a URL certa para gemini/agy.
# A API só aceita escrita vinda do próprio frontend (proteção contra CSRF/DNS rebinding).
(cd "$ROOT/backend" && LEARNHARNESS_PORT="$BACKEND_PORT" \
  LEARNHARNESS_CORS_ORIGINS="http://localhost:$FRONTEND_PORT,http://127.0.0.1:$FRONTEND_PORT" \
  uv run uvicorn learnharness.api.app:app --host 127.0.0.1 --port "$BACKEND_PORT") &
(cd "$ROOT/frontend" && BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" \
  npx next dev --port "$FRONTEND_PORT") &

echo "Lapidare: http://localhost:$FRONTEND_PORT  (API em :$BACKEND_PORT)"
wait
