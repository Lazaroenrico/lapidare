.PHONY: dev check check-backend check-frontend

# Sobe backend + frontend (respeita BACKEND_PORT, FRONTEND_PORT, LEARNHARNESS_VAULT_PATH).
dev:
	./scripts/dev.sh

check: check-backend check-frontend

check-backend:
	cd backend && uv run pytest -q && uv run ruff check src tests && uv run basedpyright

check-frontend:
	cd frontend && npm run typecheck && npm run lint && npm test && npm run build

.PHONY: desktop desktop-clean

# AppImage Linux x64: UI estatica + python embutido + casca Electron.
desktop:
	bash desktop/scripts/build-web.sh
	bash desktop/scripts/build-python.sh
	node desktop/scripts/guard-payload.mjs
	node desktop/scripts/smoke.mjs
	cd desktop && npm ci && npm run dist

desktop-clean:
	rm -rf desktop/build desktop/dist
