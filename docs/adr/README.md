---
id: adr-index
title: Architecture Decision Records
---

# Architecture Decision Records (ADR)

Immutable records of decisions with long-term consequences. Required by GR-022 for any
architectural change (definition: ARC-020 "Architectural" scope). Process:
`.skills/architecture.skill.md`.

## Rules

- Numbered sequentially: `NNNN-kebab-case-title.md`. Copy [0000-template.md](0000-template.md).
- Status flow: `proposed → accepted | rejected`; later `deprecated` or
  `superseded by ADR-NNNN`. **Accepted ADRs are never edited** — supersede them.
- One decision per ADR. Keep it under ~2 pages.
- The ADR PR is approved by a human before implementation starts (GR-022).
- Every ADR gets a line in [.ai/decision-log.md](../../.ai/decision-log.md).

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | accepted | 2026-07-02 |
| [0002](0002-ai-facing-docs-in-english.md) | AI-facing docs are written in English | accepted | 2026-07-02 |
| [0003](0003-reconcile-github-governance-from-inherited-policy.md) | Reconcile GitHub governance from inherited policy | accepted | 2026-07-15 |
| [0004](0004-harden-multi-level-template-inheritance.md) | Harden multi-level template inheritance | accepted | 2026-07-16 |
| [0005](0005-cache-and-authorization-architecture.md) | Dynamic rendering with layered cache and hybrid claim+revocation authorization | proposed | 2026-07-16 |
| [0006](0006-edge-gate-runtime-cloudflare-workers.md) | Edge authorization gate runtime uses Cloudflare Workers | proposed | 2026-07-18 |
| [0007](0007-use-one-time-protected-legacy-template-sync.md) | 保護された旧Template Syncを一度だけ使用する | accepted | 2026-07-18 |

<!-- Append new ADRs to this table (newest last). -->
