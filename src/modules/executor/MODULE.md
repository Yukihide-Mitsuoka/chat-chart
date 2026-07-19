---
id: module-executor
title: Executor Module
updated: 2026-07-19
---

# Executor Module

Purpose: compile the tenant boundary **into** a SQL query at the AST level and run it
(ADR-0005 原則C-2). It is the application-layer half of hard tenant isolation — the half
that must hold even before the datasource-layer backstop (per-tenant dataset / RLS,
LOG-0032) is reached. It does NOT own authorization decisions (the gate does), report
definitions, or NL→SQL generation.

## Public API (the contract — everything else in this module is private)

| Entry point | Layer | Description |
|-------------|-------|-------------|
| `bindQuery(sql, binding, policy)` | domain | Validate a query and rewrite it so every physical table is bound to the tenant's dataset and every row-scoped table is wrapped in its scope filter. Returns `BoundQuery` or a typed `Rejection` |
| `ExecuteQuery.execute(tenantId, sql, params)` | application | Resolve the tenant's binding, bind the SQL, run it, audit what actually ran. Refusals never reach the runner |
| `ports.ts` interfaces | application | What adapters must implement (`QueryRunner`, `BindingResolver`, `AuditSink`) |

## Events

| Direction | Event | Schema | Notes |
|-----------|-------|--------|-------|
| publishes | `query.execute` | `AuditSink` port | on success; carries the **bound** SQL and the tables touched |
| publishes | `query.refused` | `AuditSink` port | on a binder rejection, with the rejection code |
| publishes | `query.failed` | `AuditSink` port | on a runner error; the driver message stays audit-side |

## Owned data

None. The module holds no store; it transforms SQL and (once the execute use case lands)
reads the tenant's analytics dataset.

## Invariants (MUST always hold — each maps to a test)

1. Every physical table in the output is qualified to the caller's own dataset — across
   joins, CTE bodies, FROM-subqueries, WHERE-subqueries, scalar subqueries, UNION
   branches and comma joins.
2. A caller-supplied dataset qualifier (`other.orders`) is refused, never honoured.
3. Only tables on the policy allowlist are reachable; an unlisted table is refused no
   matter how deeply it is nested.
4. Only a single `SELECT` is accepted — DML, DDL and stacked statements are refused.
5. Row scope is applied at **every occurrence** of a scoped table, and an empty scope
   filters to nothing (`IN (NULL)`) rather than degrading to no filter.
6. After rewriting, the output is re-parsed and every base table verified to be bound to
   the caller's dataset; a walker gap therefore yields `rewrite-failed`, never a leak.
7. Identifiers and scope values emitted into SQL text are charset-validated; anything
   else is refused.
8. Nothing reaches the `QueryRunner` that has not been through `bindQuery` — a refusal
   short-circuits before execution.
9. The binding is resolved from a server-supplied `tenantId`; a resolver returning a
   binding for a different tenant is refused rather than followed.
10. Query parameters are passed to the runner as parameters, never interpolated into the
    SQL text.
11. An audit-sink failure never fails an otherwise successful query, and never masks a
    refusal.
12. The BigQuery runner never returns a partial answer as if it were complete: an
    incomplete job or a paged result is an error, not truncated rows.

## Dependencies

| Uses module | Via | Why |
|-------------|-----|-----|
| (none) | — | Adapters shipped: BigQuery `QueryRunner` (REST `jobs.query` + ADC) and in-memory (tests, ARC-005 second adapter). Pending: wiring into `gate`'s `QueryExecutor` port (#55). `BindingResolver` is served by the control-plane module once it exists |

External: `node-sql-parser` (Apache-2.0) for BigQuery-dialect parse/serialize — see the
COD-040 justification in the PR that introduced it.
