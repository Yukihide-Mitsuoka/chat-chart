---
id: module-gate
title: Gate Module
updated: 2026-07-18
---

# Gate Module

Purpose: the edge authorization gate of ADR-0005 — authenticates vendor-signed embed
JWTs, resolves the authorization context, and serves report shells (①) and query
results (②) through layered caches whose keys are pure functions of the
server-resolved context. It does NOT own role/permission administration (control-plane
write side), query execution (MCP gateway), or report authoring.

## Public API (the contract — everything else in this module is private)

| Entry point | Layer | Description |
|-------------|-------|-------------|
| `GateService.requestShell` | application | Serve the tenant-agnostic shell for a report (① cache, `report_id:report_version` key) |
| `GateService.requestData` | application | Serve a query result (② cache, ADR-0005 §4 key; miss → `QueryExecutor` with single-flight) |
| `ports.ts` interfaces | application | What adapters must implement (verifier, control-plane reader, KV stores, executor, hasher, audit, clock) |
| `worker.ts` default export | interface | Cloudflare Workers `fetch` entry (ADR-0006); routes `GET /r/{report}` (①) and `GET /r/{report}/data/{query}` (②), maps denials to generic client messages |

## Events

| Direction | Event | Schema | Notes |
|-----------|-------|--------|-------|
| publishes | `query.execute` audit record | `AuditSink` port | on every ② miss |

## Owned data

None — the gate owns no store of record. It reads the control plane (Postgres, 原則D)
and writes only caches (①②③, denylist), all reconstructible.

## Invariants (MUST always hold — each maps to a test)

1. Cache keys derive only from the server-resolved `AuthzContext`; client-supplied
   tenant identifiers (param or forged claim) never influence a key (原則B).
2. A cached payload whose embedded `tenantId` differs from the requester's context is
   never served (原則C-4; returns 500, serves nothing).
3. Epoch and denylist liveness checks read the SoR on every request — a cached ③
   context can never mask a revocation beyond its TTL.
4. A principal with zero grants is denied; grant absence never widens to an implicit
   all-rows scope.
5. Version-token bumps (`report_version`, `data_version`) make stale cache entries
   unreachable without any purge path (ADR-0005 §5).
6. Error responses are never cached.

## Dependencies

| Uses module | Via | Why |
|-------------|-----|-----|
| `executor` (in-process) | `ExecutorQueryAdapter` (infrastructure) → `ExecuteQuery` public API | Satisfies the `QueryExecutor` port with real AST tenant binding + BigQuery (#55). The adapter is the anti-corruption layer: it hands over the gate-owned row scope and never the dataset, so the executor stays authoritative for the ① boundary |
| `executor` (over HTTP) | `HttpQueryExecutor` (infrastructure) → the executor's `POST /v1/query` | The production Workers topology (ADR-0005 §7). Selected automatically when `EXECUTOR_URL`/`EXECUTOR_TOKEN` are set; sends tenantId + gate-derived scope, never a dataset |
| (control plane) | — | Still a port; `worker.ts` seeds an in-memory control-plane bootstrap (marked `SEAM`). `buildGate` now accepts an injected `QueryExecutor`: Node composition roots pass the real one (see `spikes/gate-executor-slice/`), while the Workers entry keeps the fallback until a gate→executor HTTP client exists |
