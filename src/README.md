---
id: src-layout
title: Source Layout
---

# src/ — Source Layout

Binding rules: [.ai/architecture.md](../.ai/architecture.md) (ARC-001..005). Summary:

```
src/
  modules/<context>/     # one bounded context per directory
    MODULE.md            # module contract — mandatory, template below
    domain/              # pure business logic; imports nothing external
    application/         # use cases; defines ports (interfaces)
    infrastructure/      # adapters implementing ports (DB, APIs, queues)
    interface/           # inbound edges (HTTP, CLI, consumers)
  shared/                # domain-free primitives used by 3+ modules (ARC-004)
tests/                   # mirrors this tree exactly (TST-001)
```

Dependency direction: `interface → application → domain` and
`infrastructure → application → domain`. Never sideways into another module's
internals — cross-module calls use the target's MODULE.md public API or events.

## Worked example — removed

The template's reference module (`modules/catalog/` + `tests/modules/catalog/`) was
deleted when this repo finished instantiation (#13), per the template's own guidance.
For a shape to imitate (COD-050), see the example in the
[ai-dev-foundation template](https://github.com/Yukihide-Mitsuoka/ai-dev-foundation).
Real RepChat modules will follow the ARC-001 layout above.

## MODULE.md template

Copy this when creating a module; keep it under one page.

```markdown
---
id: module-<context>
title: <Context> Module
updated: YYYY-MM-DD
---

# <Context> Module

Purpose: <2-3 sentences: what business capability this module owns, and what it
explicitly does NOT own>

## Public API (the contract — everything else in this module is private)
| Entry point | Layer | Description |
|-------------|-------|-------------|
| <UseCase/Function> | application | ... |

## Events
| Direction | Event | Schema | Notes |
|-----------|-------|--------|-------|
| publishes / consumes | ... | link | ... |

## Owned data
<tables/collections this module exclusively reads & writes — no other module touches them>

## Invariants (MUST always hold — each maps to a test)
1. ...

## Dependencies
| Uses module | Via | Why |
|-------------|-----|-----|
```
