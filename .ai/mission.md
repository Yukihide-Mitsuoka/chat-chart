---
id: mission
title: Mission
authority: 4
read_when: [onboarding, planning, architecture]
---

# Mission

## What this project is

RepChat — a multi-tenant embedded-analytics SaaS (Evidence rendering core × MCP
security gateway) that lets a software vendor embed customer-facing dashboards with
tenant isolation enforced in depth, plus AI-assisted report creation in natural
language. Full requirements: `docs/requirements.md` (Japanese, working language).

| Field | Value |
|-------|-------|
| Problem being solved | Vendors who want customer-facing analytics in their SaaS face Tableau-Embedded-class licensing costs, or shared-BI tools (e.g. Looker Studio) whose misconfigured sharing leaks data across customers |
| Primary users | Small software vendors embedding dashboards for *their* customers (core); small companies without data engineers (secondary) |
| Core value | Cross-tenant leakage made structurally impossible (edge gate + AST-level tenant_id injection + DB RLS + tenant-scoped cache keys), at a fraction of enterprise-BI cost, with NL→SQL report creation (Gemini Flash, ~¥0.1/query, validated 12/12 on synthetic and real schemas) |
| Explicitly out of scope | Hypergrowth/VC path (LOG-0021: deliberately small and profitable, 3–5 deeply-served customers while a side business); Stripe metered billing, self-serve tenant creation, and custom roles are deferred until manual onboarding stops scaling; general-purpose in-house BI |

## Success criteria

<!-- Measurable. AI uses these to judge whether a proposed change moves the project forward. -->

1. One design partner running RepChat in production, embedded in their own product, with zero cross-tenant data incidents.
2. Profitable at 3–5 customers: monthly revenue exceeds all cash running costs (infra + LLM + payments) with founder time as the only subsidy — per `docs/requirements.md` §7.3.

## Role of AI agents in this project

AI agents are long-term team members, not code generators. Expectations:

- **Own the full task lifecycle**: requirements clarification → design → implementation →
  tests → documentation → PR. A task is not done when code compiles; it is done when the
  Definition of Done in `workflow.md` (WF-090) is met.
- **Preserve intent**: when code and documentation disagree, investigate which is correct
  before changing either. Record the resolution.
- **Prefer reversible steps**: small PRs, feature flags, additive migrations.
- **Escalate, don't guess**: for the escalation triggers listed in `CLAUDE.md` §13, stop
  and ask the human. For everything else, decide and record the reasoning.

## Human role

Humans own: product direction, priority calls, ADR approval, release approval,
security-sensitive decisions. AI prepares options and recommendations; humans decide.
