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
# Staging dirs (~1.4 GB) are useless once the AppImage exists; CI keeps them (KEEP_UNPACKED=1)
# because its publish step reuses dist/linux-unpacked.
ifndef KEEP_UNPACKED
	rm -rf desktop/dist/linux-unpacked desktop/dist/__appImage-x64 desktop/dist/builder-debug.yml
endif

# Removes every build output, including the downloaded CPython and the Next.js cache.
desktop-clean:
	rm -rf desktop/build desktop/dist desktop/.cache frontend/out frontend/.next/cache
