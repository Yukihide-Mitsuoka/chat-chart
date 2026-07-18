---
id: project-documentation-guide
title: Project Documentation Guide
---

# Project Documentation Guide

This guide defines where an instantiated repository stores project-owned documentation.
Binding rules live in [`.ai/`](../../../.ai/); inherited decisions live in the
[foundation ADRs](../adr/), project decisions live in `docs/adr/`, and writing rules live in
[`.ai/documentation.md`](../../../.ai/documentation.md).

| Directory | Content | Primary reader task |
|-----------|---------|---------------------|
| [docs/foundation/adr/](../adr/) | Synchronized foundation Architecture Decision Records (**normative** when accepted) | "why does the inherited foundation work this way?" |
| `docs/adr/` | Project Architecture Decision Records (**normative** when accepted) | "why is this project built this way?" |
| [docs/foundation/](../) | Synchronized foundation-owned guidance and document templates | use inherited documentation support |
| `docs/requirements.md`, `docs/requirements/` | Project-owned whole-project and initiative requirements | determine what must be built and why |
| `docs/architecture/` | System structure, C4 diagrams, data flows | understand before changing structure |
| `docs/domain/` | Domain model, bounded contexts, ubiquitous language | understand the business rules |
| `docs/api/` | API contracts (OpenAPI/schema + commentary) | integrate with or change an API |
| `docs/deployment/` | Environments, deploy procedure, configuration | ship it |
| `docs/operations/` | Monitoring, alerts, SLOs, maintenance | keep it running |
| `docs/runbook/` | Step-by-step incident/ops procedures | 3am emergency |
| `docs/troubleshooting/` | Known failure modes → diagnosis → fix | "it's broken, what now?" |
| `docs/roadmap.md` | Direction and planned milestones | prioritize work |
| `docs/glossary.md` | Project ubiquitous language dictionary | name things correctly |

Contribution guide: [CONTRIBUTING.md](../../../CONTRIBUTING.md).

The guides in this directory define structure and **update triggers** without placing
foundation-owned README files in project-owned paths. The doc-update matrix (DOC-030)
tells you which project directory a given change must touch.
