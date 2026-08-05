.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose -f smoke/docker-compose.yml

# Bind-mounted out of the smoke-test containers, so the installed tree can be
# inspected from the host after the container exits.
OUT_DIR := test-output

# The containers run as the invoking user, so what lands in OUT_DIR is owned by
# them. Without this the output is root-owned on Linux, unreadable to a CI
# artifact step and undeletable by the runner.
export SMOKE_UID := $(shell id -u)
export SMOKE_GID := $(shell id -g)

# `docker compose run --rm` already tears the container down on exit, including
# on Ctrl-C, so there is no lingering state to trap for. `smoke-clean` exists for
# the image and build cache, which do outlive a run.
.PHONY: help install build test typecheck lint check smoke smoke-codex smoke-claude smoke-build smoke-output smoke-clean clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	bun install

build: ## Build dist/
	bun run build

test: ## Run the unit test suite (no network)
	bun test

typecheck: ## Typecheck src, tests, and the smoke-test example
	bun run typecheck
	bun run typecheck:smoke

lint: ## Lint
	bun run lint

check: typecheck lint test ## Everything that must pass before a commit

# ---------------------------------------------------------------------------
# Container smoke tests
#
# These build the package as published and install it into a fresh container, so
# they need the network and take longer than `make check`. Kept out of `check`
# for that reason.
# ---------------------------------------------------------------------------

smoke-build: ## Build the smoke-test image
	$(COMPOSE) build

# Created on the host before the mount exists, so the directory belongs to the
# invoking user. Left to Docker, it would be created by the daemon instead: root
# on Linux, which then needs sudo to clean up.
$(OUT_DIR)/%:
	mkdir -p $@

smoke-codex: smoke-build $(OUT_DIR)/codex ## Smoke-test the Codex target in a fresh container
	$(COMPOSE) run --rm codex

smoke-claude: smoke-build $(OUT_DIR)/claude ## Smoke-test the Claude target in a fresh container
	$(COMPOSE) run --rm claude

smoke: smoke-codex smoke-claude ## Smoke-test both harnesses

smoke-output: ## Show what the last smoke run left behind
	@test -d $(OUT_DIR) || { echo "no $(OUT_DIR)/. Run 'make smoke' first"; exit 1; }
	@find $(OUT_DIR) -type f | sort

smoke-clean: ## Remove smoke-test containers, images, and output
	-$(COMPOSE) down --rmi local --remove-orphans
	rm -rf $(OUT_DIR)

clean: smoke-clean ## Remove build output and smoke-test artifacts
	rm -rf dist
