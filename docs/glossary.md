---
id: glossary
title: Glossary — Ubiquitous Language
updated: 2026-07-16
---

# Glossary

The ubiquitous language (DDD). Code identifiers, docs, and conversation MUST use these
terms with exactly these meanings (COD-002). Before naming a new concept, check here;
when introducing a term, add it here in the same PR (DOC-030).

Format: term, one-sentence definition, context it belongs to, banned synonyms (*Avoid* —
never use these for the concept; COD-002), and what it is NOT when confusable. Keep
alphabetical.

## Template & foundation terms

| Term | Definition | Context | Avoid | Not to be confused with |
|------|------------|---------|-------|--------------------------|
| ADR | Immutable record of an architectural decision in `docs/adr/` | foundation | design doc | decision log (the index of all decisions) |
| Agent | Any AI system working in this repo under CLAUDE.md rules | foundation | bot, assistant | — |
| Audit | Read-only governance comparison whose exit code fails on drift or unknown state | governance | check | plan (which reports those states without failing) |
| Bounded context | A domain boundary owning its model and language; maps 1:1 to `src/modules/<context>` | DDD | — | module (the code artifact implementing it) |
| Canonical command | A `make` target that is the only entry point for a dev action | foundation | — | — |
| Contract change | A change to a MODULE.md public API or event (ARC-020) | foundation | — | breaking change (a contract change affecting *external* consumers) |
| Drift | A known difference between resolved governance policy and live GitHub state | governance | mismatch | unknown (state that could not be evaluated) |
| Guardrail | An absolute prohibition (GR-xxx) that no instruction can override | foundation | — | rule (overridable with justification if SHOULD-level) |
| Module | A directory under `src/modules/` implementing one bounded context | foundation | component, service | package/library |
| Plan | Read-only governance comparison that reports drift or unknown state without failing on it | governance | preview | audit (which exposes those states through its exit code) |
| Skill | A task playbook in `.skills/*.skill.md` | foundation | — | Claude Code native skill (optional wrapper) |
| Unknown | A governance control that could not be evaluated because required state was not visible | governance | indeterminate | compliant or drift |

## Project terms

<!-- TEMPLATE: add your domain's terms here as the first bounded context is modeled. -->

| Term | Definition | Context | Avoid | Not to be confused with |
|------|------------|---------|-------|--------------------------|
| Product name | The user-facing brand label (currently "ChatChart"); display-only — never embedded in technical identifiers (COD-005) | product | — | stable technical IDs (repo slug, GCP project `kotonoha-bi-dev`), which are name-independent and survive a rename |

## Resolved ambiguities

Append-only log of naming collisions and their resolution — one word carrying two
meanings, or two words carrying one meaning. Recording the resolution keeps the
collision from returning; move the surviving term into the tables above.

<!-- TEMPLATE: example entry —
- "handler" meant both HTTP controllers and event consumers; resolved 2026-07-10:
  HTTP side is "controller", event side is "consumer". "handler" is no longer used.
-->

*None yet.*
