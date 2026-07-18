---
id: adr-index
title: Architecture Decision Records
---

# Foundation Architecture Decision Records (ADR)

Immutable records of decisions owned by `ai-dev-foundation` and synchronized to
downstream repositories. Project-specific decisions belong in `docs/adr/`. Both use the
process in `.skills/architecture.skill.md`.

## Rules

- Numbered sequentially: `NNNN-kebab-case-title.md`. Copy the
  [foundation ADR template](../templates/adr.md).
- Status flow: `proposed → accepted | rejected`; later `deprecated` or
  `superseded by ADR-NNNN`. **Accepted ADRs are never edited** — supersede them.
- One decision per ADR. Keep it under ~2 pages.
- The ADR PR is approved by a human before implementation starts (GR-022).
- Every ADR gets a line in [.ai/decision-log.md](../../../.ai/decision-log.md).

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | accepted | 2026-07-02 |
| [0002](0002-ai-facing-docs-in-english.md) | AI-facing docs are written in English | accepted | 2026-07-02 |
| [0003](0003-reconcile-github-governance-from-inherited-policy.md) | Reconcile GitHub governance from inherited policy | accepted | 2026-07-15 |
| [0004](0004-harden-multi-level-template-inheritance.md) | Harden multi-level template inheritance | accepted | 2026-07-16 |
| [0005](0005-separate-foundation-and-project-document-languages.md) | Separate foundation and project document languages | accepted | 2026-07-18 |
| [0006](0006-reserve-a-foundation-documentation-namespace.md) | Reserve a foundation documentation namespace | accepted | 2026-07-18 |

<!-- Append new ADRs to this table (newest last). -->
