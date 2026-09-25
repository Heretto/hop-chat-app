.PHONY: install env dev start backend frontend test doctor build

PY := backend/.venv/bin/python

install:  ## Install/refresh backend + frontend dependencies (./dev.sh --install)
	./dev.sh --install
	cd backend/tests/widget_js && npm ci --no-audit --no-fund

env:  ## Write backend/.env with fresh secrets (never overwrites)
	./scripts/setup.sh

backend:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm start

dev start:  ## Install what's missing, then run everything on free ports (./dev.sh)
	./dev.sh

test:
	cd backend && .venv/bin/python -m pytest -q
	cd backend/tests/widget_js && npm test

doctor:
	backend/.venv/bin/hop-doctor

build:
	cd frontend && npm run build:prod
