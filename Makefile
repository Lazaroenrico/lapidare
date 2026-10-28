.PHONY: dev check check-backend check-frontend

# Sobe backend + frontend (respeita BACKEND_PORT, FRONTEND_PORT, LEARNHARNESS_VAULT_PATH).
dev:
	./scripts/dev.sh

check: check-backend check-frontend

check-backend:
	cd backend && uv run pytest -q && uv run ruff check src tests && uv run basedpyright

check-frontend:
	cd frontend && npm run typecheck && npm run lint && npm test && npm run test:components && npm run build

.PHONY: desktop desktop-clean desktop-install desktop-uninstall

# Desktop: UI estatica + python embutido + casca Electron. Linux x64 e macOS (arm64 ou x64, o da maquina).
# TARGETS (so Linux) escolhe os pacotes: o padrao e so o AppImage; a CI usa "AppImage deb rpm"
# (o rpm precisa de `rpmbuild` na maquina de build).
TARGETS ?= AppImage
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_S),Darwin)
  ifeq ($(UNAME_M),arm64)
    MAC_ARCH := arm64
  else
    MAC_ARCH := x64
  endif
endif

desktop:
	bash desktop/scripts/build-web.sh
	bash desktop/scripts/build-python.sh
	node desktop/scripts/guard-payload.mjs
	node desktop/scripts/smoke.mjs
	cd desktop && npm ci
ifeq ($(UNAME_S),Darwin)
	cd desktop && npx electron-builder --mac dmg --$(MAC_ARCH)
else
	cd desktop && npx electron-builder --linux $(TARGETS) --x64
endif
# Staging dirs (~1.4 GB) are useless once the packages exist; CI keeps them (KEEP_UNPACKED=1)
# for its smoke tests on the unpacked app.
ifndef KEEP_UNPACKED
	rm -rf desktop/dist/linux-unpacked desktop/dist/__appImage-x64 desktop/dist/mac desktop/dist/mac-arm64 desktop/dist/builder-debug.yml
endif

# Removes every build output, including the downloaded CPython and the Next.js cache.
desktop-clean:
	rm -rf desktop/build desktop/dist desktop/.cache frontend/out frontend/.next/cache

# Puts the built AppImage in ~/Applications with an icon and a .desktop entry (app launchers).
desktop-install:
	bash desktop/scripts/install-desktop-entry.sh

desktop-uninstall:
	bash desktop/scripts/install-desktop-entry.sh --uninstall
