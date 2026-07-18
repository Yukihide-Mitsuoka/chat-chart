---
id: usage
title: Usage — New Machine, New Account, New Project
updated: 2026-07-16
---

# Usage

> 日本語版: [usage.ja.md](usage.ja.md)（人間向けセットアップ手順書）

This guide covers using the foundation from a different machine or a different GitHub
account. **First decide which of two scenarios you are in — the steps differ.**

| Scenario | You want to... | Use |
|----------|----------------|-----|
| A | Start a **new project** built on this foundation | GitHub **"Use this template"** (not `git clone`) |
| B | Continue developing **this foundation itself** on another machine | `git clone` |

`git clone` alone is only the right answer for Scenario B. For Scenario A, cloning would
drag this repo's history and identity into your new project; use the template flow.

---

## Scenario A — start a new project from the template

The template repository flag is enabled, so this is one action plus a short setup.

### 1. Create the new repo from the template

Web: open the template repo → **Use this template** → **Create a new repository**.

CLI (equivalent):
```bash
gh repo create <your-account>/<new-project> \
  --template Yukihide-Mitsuoka/ai-dev-foundation \
  --private --clone
cd <new-project>
```
This gives you a **fresh repo with clean history** under your account.

### 2. Replace template placeholders

Every customizable value is a `{{...}}` token. Find them all:
```bash
grep -rn "{{" . --exclude-dir=.git
```
Replace at minimum: `{{PROJECT_NAME}}`, `{{STACK}}` and the other `{{...}}` in
`.ai/mission.md` and `CLAUDE.md`; `{{ORG}}` in `.github/CODEOWNERS`,
`.github/ISSUE_TEMPLATE/config.yml`, and `.github/workflows/template-sync.yml`;
`{{PACKAGE}}` if you use the python profile.

### 3. Fix CODEOWNERS for your account type

`.github/CODEOWNERS` ships with **team** references (`@{{ORG}}/maintainers`). Teams only
exist under **GitHub Organizations**. On a **personal account**, replace them with your
username:
```
*   @your-username
```
Leaving team syntax on a personal repo makes CODEOWNERS silently ineffective —
fix this file before applying governance because account-type inference is outside the
compatibility wrapper.

### 4. Pick a Makefile profile

Copy the closest reference implementation to the repo root and wire it to your stack:
```bash
cp profiles/python-uv/Makefile ./Makefile      # or typescript-node / terraform-gcp
```
See [profiles/README.md](../../../profiles/README.md) for the canonical target contract.

### 5. Inspect GitHub governance

```bash
python3 scripts/github_governance.py validate --root .
python3 scripts/github_governance.py plan --root . --repo OWNER/REPOSITORY
python3 scripts/github_governance.py audit --root . --repo OWNER/REPOSITORY
python3 scripts/github_governance.py apply --root . --repo OWNER/REPOSITORY \
  --confirm-repo OWNER/REPOSITORY

# Compatibility entry point for the same plan/apply paths:
DRY_RUN=1 bash scripts/setup-github.sh OWNER/REPOSITORY
bash scripts/setup-github.sh OWNER/REPOSITORY --confirm-repo OWNER/REPOSITORY
```

`validate` is offline and automatically resolves the foundation, the single profile
chain in `.github/governance/profiles/`, and repository policy. Required checks are
monotonic: profiles and repository policy add checks but cannot remove foundation
checks. `plan` and `audit` use authenticated, GET-only `gh api` calls and
print the same redacted JSON comparison. The comparison flags a required check name that
is not observed on the target branch head and ignores unrelated observed checks. `plan`
returns 0 after a completed comparison; `audit` returns 1 for drift or permission-limited
unknown state. Both return 2 for policy, input, or GitHub read failures.

See [GitHub governance troubleshooting](../troubleshooting/github-governance.md) for an
`audit` exit 1 diagnosis.

Review `plan` before `apply`. Only `apply` changes settings; it requires local repository
Administration access and an exact target confirmation, then verifies each action by
read-back. Policy enforces squash-only merges and lets repository overrides choose
Discussions and squash commit-message defaults. The setup compatibility wrapper makes no
direct `gh` call: `DRY_RUN` maps to `plan`, while normal execution requires the exact
target twice and maps to `apply`. Its exit code is the reconciler exit code.

Migration from the fixed script: the no-argument form is removed, and the wrapper no
longer prints CODEOWNERS or other manual onboarding reminders. Pass the target explicitly
as shown above and use this guide as the onboarding checklist.

### 6. Install local gates and point your agent at it

```bash
make setup                             # installs deps + pre-commit hooks
```
Open the repo with Claude Code (reads `CLAUDE.md` automatically) or tell any other agent
to read `AGENTS.md`. Assign it an issue and go.

The template ships a worked example module (`src/modules/catalog/` + `tests/modules/catalog/`)
— imitate its shape (COD-050) or delete both when you start real code. Run `make doctor`
anytime to self-check the template (frontmatter integrity + guard-hook tests).

---

## Scenario B — clone the foundation itself onto another machine

```bash
git clone https://github.com/Yukihide-Mitsuoka/ai-dev-foundation.git
cd ai-dev-foundation
# The bare template's root Makefile is a no-op, so `make setup` does nothing here.
# Install the git hooks directly (needs pre-commit — see prerequisites):
pre-commit install --hook-type pre-commit --hook-type pre-push
make doctor                            # verify the template is intact
```
That is genuinely "just clone" — but each new machine still needs the one-time
**prerequisites** and **auth** below.

---

## Per-machine prerequisites (both scenarios)

Install once on each new machine:

| Tool | Needed for | Notes |
|------|-----------|-------|
| `git`, `make` | everything | — |
| `gh` (GitHub CLI) | Governance `plan`/`audit`/`apply`, compatibility setup, auth | `gh auth login` |
| `pre-commit` | local commit gates | `make setup` (once a profile is wired) or `pre-commit install` |
| Stack toolchain | build/test | uv (python), pnpm+node (ts), terraform (iac) — per your profile |
| `gitleaks`, `trivy`, `syft` | local `make security-scan` / `sbom` | optional locally; **CI enforces them regardless** |

The scanners are optional on your laptop — the GitHub Actions workflows run them on every
PR, so a missing local tool only means you don't see findings until CI.

---

## Gotchas (read before you hit them)

### `workflow` OAuth scope is required to push
Pushing any change under `.github/workflows/` needs the token's `workflow` scope. If
`git push` is rejected with *"refusing to allow an OAuth App to create or update
workflow ... without workflow scope"*:
```bash
gh auth refresh -h github.com -s workflow
```
This is a **per-account / per-machine** setting — expect to do it once on each new setup.

### Solo developer + branch protection = you can't merge your own PRs
Set `required_approvals` in `.github/governance/repository.json` to match the repository.
Requiring one approval on a repo with no second reviewer prevents self-merge. Choose one:

- **Recommended (keeps the guardrail):** add a second collaborator/reviewer, or enable
  the AI reviewer ([ai-review.yml](../../../.github/workflows/ai-review.yml)) — note an AI
  review comment does not count as a GitHub *approval*, so for true self-merge you still
  need option below.
- **Solo pragmatic:** set `"required_approvals": 0` in repository policy.
  You still branch + PR + green CI (GR-010, GR-021); you just merge it yourself.

`scripts/setup-github.sh` delegates to the same repository policy, so the configured
approval count applies equally through the direct CLI and compatibility entry point.

### Line endings
`.gitattributes` enforces LF repo-wide, so shell hooks and Makefiles stay valid on
Windows. Don't override with a global `core.autocrlf=true` that fights it — the
`.gitattributes` wins for matched files, but keep your Git default sane.

### Placeholders that break automation if left unreplaced
`{{ORG}}` in `template-sync.yml` and `CODEOWNERS`, and the issue-config URLs, are the
ones that cause silent failures (ineffective CODEOWNERS, a sync job that can't find its
source). The template-sync job is gated off by default (`TEMPLATE_SYNC_ENABLED`), so it
stays inert until you deliberately enable it.

---

## Quick answer: "is `git clone` enough on a different account?"

- **To develop this foundation** (Scenario B): yes — `git clone` + `make setup` +
  `gh auth refresh -s workflow` on that machine.
- **To start a new project** (Scenario A): no — use "Use this template", then the
  6 setup steps above. Cloning would give the new project this repo's history and
  placeholders instead of a clean start.
