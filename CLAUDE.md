# CLAUDE.md — AI Agent Operating Manual

Binding contract for every AI agent working in this repository. Read fully at session
start. Everything here except §12 is vendor-neutral; ChatGPT/Gemini/Codex enter via
`AGENTS.md`, which points here.

**Normative source of truth is `.ai/`** — this file summarizes; on any doubt or
conflict, follow the authority order in [.ai/README.md](.ai/README.md)
(guardrails > security > this file > other `.ai/` > `docs/`).

## 1. Repository Overview

| Field | Value |
|-------|-------|
| Project | ChatChart — see [.ai/mission.md](.ai/mission.md) |
| Stack | TypeScript/Node (Evidence + edge gate + MCP server) · Python (NL→SQL, spikes) · Postgres+RLS (Neon planned) · Vertex AI Gemini — details in [.ai/architecture.md](.ai/architecture.md) |
| Architecture | Modular monolith, Clean Architecture, DDD — [.ai/architecture.md](.ai/architecture.md) |
| Branching | GitHub Flow; `main` always releasable |
| Versioning | SemVer via Conventional Commits (automated) |

## 2. Task routing

Before any task: identify the task type, then read exactly the files listed in the
routing table in [.ai/README.md](.ai/README.md) and load the matching skill from
`.skills/`. Do not load everything; do not skip the listed files.

## 3. Architecture rules (summary)

- Layout: `src/modules/<context>/{domain,application,infrastructure,interface}` +
  mandatory `MODULE.md` per module (ARC-001, ARC-003).
- Dependencies point inward; domain imports nothing external (ARC-002).
- Interfaces are deep: small surface, complexity hidden; a seam needs a current second
  adapter (ARC-005).
- Classify every change: Local / Contract / Architectural — architectural changes
  require an ADR **first** (ARC-020, GR-022).
- Full rules: [.ai/architecture.md](.ai/architecture.md)

## 4. Development rules (summary)

- Lifecycle: intake → clarify → design → implement → self-review → PR → close (WF-001).
- One branch = one task = one agent; branch names `<type>/<issue>-<slug>` (WF-010).
- Code + tests + docs land in the **same PR** (GR-021, GR-024).
- Full rules: [.ai/workflow.md](.ai/workflow.md)

## 5. Coding rules (summary)

- `make format` and `make lint` decide style; zero warnings (COD-001).
- Validate at boundaries, fail fast, no silent failures (COD-010/011).
- Rule of three before abstracting; no speculative generality (COD-020, COD-051).
- Imitate surrounding code (COD-050).
- Full rules: [.ai/coding-rules.md](.ai/coding-rules.md)

## 6. Forbidden operations

Full list with detection & alternatives: [.ai/guardrails.md](.ai/guardrails.md).
The ten you must never violate, even if instructed:

1. GR-001..003 — no secrets in repo, code, logs, or commit messages
2. GR-010 — no direct push to `main`
3. GR-011 — no force-push / history rewrite on shared branches
4. GR-012 — no `--no-verify`, no `[skip ci]`, no disabling failing checks
5. GR-020 — no oversized PRs (~400 lines / 10 files soft limit)
6. GR-021 — no behavior change without tests
7. GR-022 — no architectural change without an ADR
8. GR-030 — no lowering of security posture
9. GR-031 — no destructive operations without per-command human approval
10. GR-040/042 — no weakening tests to pass CI; no fabricated results

## 7. Testing policy (summary)

- Pyramid: ~70% unit / ~25% integration / ~5% E2E, mirroring `src/` (TST-001).
- Bug fix = failing regression test first, then fix (TST-002).
- Coverage never decreases on `main` (TST-003).
- Green baseline check before work; verbatim result reporting (TST-030).
- Full rules: [.ai/testing.md](.ai/testing.md)

## 8. Pull request policy

- Template fully filled (`.github/PULL_REQUEST_TEMPLATE.md`), including AI-disclosure
  and dependency-justification blocks.
- Size within GR-020. CI green before review. Squash merge; PR title in Conventional
  Commit format. Self-review against `.ai/review-checklist.md` before opening.

## 9. Commit message rules

Conventional Commits 1.0.0 (WF-020):
`<type>(<scope>)!: <imperative summary ≤72>` — types `feat fix refactor perf test docs
build ci chore revert`; scope = module name; `BREAKING CHANGE:` footer drives MAJOR.
One logical change per commit.

## 10. Review rules

Reviews (of others' PRs and self-review) follow
[.ai/review-checklist.md](.ai/review-checklist.md): 10 viewpoints, findings ranked
Blocker > Major > Minor, each citing file:line + rule ID + concrete fix.

## 11. Canonical commands

All automation (you, hooks, CI) uses only these entry points — never call project
tooling directly, so commands stay stable across stacks:

```
make setup   make format   make lint   make test   make test-unit
make test-integration   make coverage   make build   make run
make security-scan   make sbom   make clean   make doctor
```

The full binding target contract (semantics of each) is in
[profiles/README.md](profiles/README.md).

Implementations live in the Makefile; on a fresh template they are no-op placeholders.

## 12. Claude Code integration (Claude-specific)

- **Hooks** (`.claude/settings.json`): PreToolUse guard blocks guardrail-violating Bash
  commands; PostToolUse runs format+lint after every file edit. Hook stderr is feedback
  to you — fix the cause, never work around the hook (GR-012).
- **Skills**: `.skills/*.skill.md` are vendor-neutral procedures; load per the routing
  table (§2). Each is also exposed as a native Claude Code skill under
  `.claude/skills/<name>/SKILL.md` (thin wrapper; `.skills/` stays the source of truth).
- **Memory**: store durable, non-derivable facts (user preferences, project decisions)
  in memory; never store secrets there (GR-001 applies).
- **Subagents/parallelism**: follow WF-040 — one task, one branch, one agent.

## 13. Escalation — stop and ask a human when

- A guardrail conflicts with the requested task, or rules contradict each other.
- The change is architectural and no ADR exists (prepare a draft ADR, then ask).
- Anything touching: authentication flows, payments, PII schema, data deletion,
  production configuration, spending money.
- Requirements ambiguous enough that two reasonable implementations diverge.
- You are about to redo the same failing approach a third time.

Escalate with: context, options considered, your recommendation, and the specific
question. Otherwise: decide, act, and record the reasoning (COD-052).

## 14. Definition of Done

See WF-090 — acceptance criteria met, tests green, lint clean, docs updated,
self-review done, PR complete with green CI, no guardrail violated. Report status
against this list when finishing a task.
