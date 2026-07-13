# portico — one token, every service.
#
#   make setup     first run: install deps + create .env with fresh secrets
#   make dev       hot-reload API + portal (browse http://localhost:5173)
#   make run       production-shaped: build, then serve everything on :8080
#   make test      the full suite (no infrastructure required)
#
# `make dev` and `make run` load .env; `make test` deliberately does not, so the
# suite proves it needs no credentials.

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE  := docker compose
API_PORT ?= 8080
WEB_PORT ?= 5173
DB_URL   ?= postgresql://portico:portico@localhost:5432/portico

# Colour, but only on a terminal.
BOLD := $(shell tput bold 2>/dev/null)
DIM  := $(shell tput dim 2>/dev/null)
OFF  := $(shell tput sgr0 2>/dev/null)

.PHONY: help
help: ## Show this help
	@echo "$(BOLD)portico$(OFF)"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BOLD)%-12s$(OFF) %s\n", $$1, $$2}'
	@echo
	@echo "$(DIM)First time:  make setup  →  fill in .env  →  make dev$(OFF)"

# --- setup ------------------------------------------------------------------

.PHONY: setup
setup: install .env ## First run: install dependencies and create .env
	@echo
	@echo "$(BOLD)Next:$(OFF) put your Google + Atlassian OAuth credentials in .env, then 'make dev'."
	@echo "$(DIM)Google:    console.cloud.google.com → Credentials → OAuth client (Web application)$(OFF)"
	@echo "$(DIM)           redirect URI: http://localhost:$(API_PORT)/auth/google/callback$(OFF)"
	@echo "$(DIM)Atlassian: developer.atlassian.com → your app → OAuth 2.0 (3LO)$(OFF)"
	@echo "$(DIM)           callback URL: http://localhost:$(API_PORT)/connect/atlassian/callback$(OFF)"

.PHONY: install
install: ## Install npm dependencies (API + portal)
	npm install

# Generates .env with real secrets. Never clobbers an existing one.
.env: .env.example
	@if [ -f .env ]; then \
	  echo "$(DIM).env already exists — leaving it alone (see .env.example for new keys)$(OFF)"; \
	  touch .env; \
	else \
	  sed -e "s|^PORTICO_ENCRYPTION_KEY=.*|PORTICO_ENCRYPTION_KEY=$$(openssl rand -base64 32)|" \
	      -e "s|^PORTICO_SESSION_SECRET=.*|PORTICO_SESSION_SECRET=$$(openssl rand -base64 32)|" \
	      .env.example > .env; \
	  echo "$(BOLD)Created .env$(OFF) with freshly generated secrets."; \
	fi

.PHONY: env
env: .env ## Create .env from .env.example with generated secrets

# --- database ---------------------------------------------------------------

.PHONY: up
up: ## Start Postgres (docker compose) and wait until it is ready
	$(COMPOSE) up -d postgres
	@printf "waiting for postgres"
	@until $(COMPOSE) exec -T postgres pg_isready -U portico -d portico >/dev/null 2>&1; do \
	  printf "."; sleep 1; \
	done; echo " ready."

.PHONY: down
down: ## Stop Postgres (keeps data)
	$(COMPOSE) down

.PHONY: db-reset
db-reset: ## Destroy the database volume and start fresh
	$(COMPOSE) down -v
	@$(MAKE) --no-print-directory up

.PHONY: psql
psql: ## Open a psql shell on the dev database
	$(COMPOSE) exec postgres psql -U portico -d portico

# --- run --------------------------------------------------------------------

.PHONY: dev
dev: .env up ## Hot-reload API (:8080) + portal (:5173) — browse the portal
	@echo "$(BOLD)portal → http://localhost:$(WEB_PORT)$(OFF)  $(DIM)(API on :$(API_PORT))$(OFF)"
	@set -a; . ./.env; set +a; \
	PORTICO_PORTAL_URL=http://localhost:$(WEB_PORT) \
	npx concurrently --names api,web --prefix-colors blue,magenta --kill-others \
	  "npm run dev" \
	  "npm run dev:web"

.PHONY: run
run: .env build up ## Build, then serve API + portal together on :8080
	@echo "$(BOLD)portico → http://localhost:$(API_PORT)$(OFF)"
	@set -a; . ./.env; set +a; npm start

.PHONY: build
build: ## Compile the API (tsc) and the portal (vite)
	npm run build

# --- checks -----------------------------------------------------------------

.PHONY: test
test: ## Run the full suite (in-memory adapters, no infra needed)
	npm test

.PHONY: test-watch
test-watch: ## Re-run tests on change
	npm run test:watch

.PHONY: test-pg
test-pg: up ## Run the suite against the docker Postgres
	PORTICO_TEST_DATABASE_URL=$(DB_URL) npm test

.PHONY: typecheck
typecheck: ## Typecheck the API and the portal
	npm run typecheck

.PHONY: check
check: typecheck test ## Everything CI would run

# --- housekeeping -----------------------------------------------------------

.PHONY: clean
clean: ## Remove build output and local artifact files
	rm -rf dist web/dist .data

.PHONY: docker-build
docker-build: ## Build the production container image
	docker build -t portico:local .
