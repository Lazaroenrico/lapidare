.PHONY: dev check check-backend check-frontend

# Sobe backend + frontend (respeita BACKEND_PORT, FRONTEND_PORT, LEARNHARNESS_VAULT_PATH).
dev:
	./scripts/dev.sh

check: check-backend check-frontend

check-backend:
	cd backend && uv run pytest -q && uv run ruff check src tests

check-frontend:
	cd frontend && npm run typecheck && npm test && npm run build
