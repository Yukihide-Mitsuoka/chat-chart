# Canonical command interface (CLAUDE.md §11) — TypeScript/Node implementation.
# Adapted from profiles/typescript-node (contract semantics: profiles/README.md).
# Deliberate deviations, to keep the dependency tree (and its committed lockfile)
# within GR-020: npm instead of pnpm; node:test instead of Vitest; lint =
# prettier --check + tsc --noEmit (ESLint added when a rule earns its place).
# Tests run .ts directly via Node >=24 type stripping (tsconfig erasableSyntaxOnly).

.PHONY: setup format lint test test-unit test-integration coverage build run \
        security-scan sbom clean help doctor

FILE ?=

help: ## List available targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-18s %s\n", $$1, $$2}'

setup: ## Install toolchain: node deps (from lockfile) + git hooks
	npm ci --no-fund --no-audit
	@if command -v pre-commit >/dev/null 2>&1; then \
		pre-commit install --hook-type pre-commit --hook-type pre-push; \
	else echo "pre-commit not installed — local gates skipped (CI still enforces)"; fi

format: ## Auto-format code (all, or FILE=<path>)
ifneq ($(FILE),)
	npx prettier --write --ignore-unknown "$(FILE)"
else
	npx prettier --write .
endif

lint: ## Lint code, zero warnings allowed — COD-001 (all, or FILE=<path>)
ifneq ($(FILE),)
	npx prettier --check --ignore-unknown "$(FILE)"
else
	npx prettier --check .
	npx tsc --noEmit
endif

test: ## Full test suite (unit + integration) — TST-001
	node --test "tests/**/*.test.ts"

test-unit: ## Fast unit suite only, used by pre-commit — TST-001
	node --test --test-skip-pattern "integration|e2e" "tests/**/*.test.ts"

test-integration: ## Integration suite (may use containers)
	node --test --test-name-pattern "integration|e2e" "tests/**/*.test.ts"

coverage: ## Test with coverage report — TST-003 ratchet
	node --test --experimental-test-coverage "tests/**/*.test.ts"

build: ## Produce deployable artifact (typecheck-only until the Workers adapter lands)
	npm run build

run: ## Run the application locally
	npm run dev

security-scan: ## Local security sweep (secrets + deps + config)
	@if command -v gitleaks >/dev/null 2>&1; then gitleaks detect --no-banner; else echo "[template] gitleaks not installed — CI still enforces SEC-002"; fi
	@if command -v trivy >/dev/null 2>&1; then trivy fs --scanners vuln,misconfig,secret --exit-code 1 .; else echo "[template] trivy not installed — CI still enforces SEC-030"; fi
	npm audit --audit-level=high

sbom: ## Generate SBOM (SPDX + CycloneDX) into ./dist — REL-020
	@mkdir -p dist
	@if command -v syft >/dev/null 2>&1; then syft . -o spdx-json=dist/sbom.spdx.json -o cyclonedx-json=dist/sbom.cdx.json && echo "SBOM written to dist/"; else echo "[template] syft not installed — release workflow generates the authoritative SBOM"; fi

clean: ## Remove build artifacts
	@rm -rf dist coverage node_modules/.cache

doctor: ## Self-check the template: metadata invariants + guard-hook tests (foundation-level, stack-independent)
	@bash scripts/template-check.sh
	@bash .claude/hooks/tests/guard-bash.test.sh
