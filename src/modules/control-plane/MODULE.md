---
id: module-control-plane
title: Control Plane Module
updated: 2026-07-24
---

# Control Plane Module

Purpose: the system-of-record for tenant management (tenants / users / roles / reports /
datasources — 原則D), served to the other modules through the ports they already define.
It owns the Postgres/Neon adapters and connects as the RLS-constrained `app_runtime`
role. It does NOT own authorization *decisions* (the gate does) or query execution (the
executor does) — it answers reads and writes the audit log.

## Public API (the contract — everything else in this module is private)

| Entry point | Layer | Description |
|-------------|-------|-------------|
| `ControlPlaneDb` | infrastructure | Connects as `app_runtime`; `withTenant(id, fn)` runs `fn` in a tx with `app.tenant_id` set so RLS applies |
| `PgControlPlaneReader` | infrastructure | Implements the gate's `ControlPlaneReader` (epoch, user+grants, report/data versions) |
| `PgBindingResolver` | infrastructure | Implements the executor's `BindingResolver` + `QueryCatalog` (dataset, table policy, queryId→SQL) |
| `PgAuditSink` | infrastructure | Writes `audit_logs`; satisfies the gate's and executor's `AuditSink` shape |

## Owned data

The control-plane Postgres schema (`migrations/`): tenants, users, roles,
role_permissions, user_roles, reports, report_queries, role_reports, datasources,
audit_logs, revocation_events, plus the boundary-external vendors / vendor_keys /
permissions.

## Invariants (MUST always hold — each maps to a test)

1. Every tenant-scoped read runs inside `withTenant`, so RLS constrains it — a missing
   WHERE clause cannot leak across tenants (proven live on Neon; LOG-0032).
2. The connection is `app_runtime`, never the owner — the owner bypasses RLS.
3. The ① dataset is read from the tenant's datasource row and returned to the executor;
   it is never accepted from a caller.
4. `data_scope` JSONB maps to `DataScope` fail-safe: an unparseable scope becomes `all`
   (caught upstream by the report allow-list), never a crash.
5. Report identifiers exposed to the gate are report **slugs** (the URL identifier),
   resolved to ids only inside joins.

## Runtime shape

Node-only: the porsager `postgres` driver uses TCP sockets, so these adapters run in a
Node composition root (local dev, and a Node-hosted gate/executor). The **Workers** gate
reaches the control plane over a transport instead — a follow-up that mirrors the
executor's HTTP transport (#65). The table allowlist (`QueryPolicy`) is injected for
Phase 1's single datasource shape; it becomes per-tenant data when a second shape appears
(COD-051).

## Dependencies

| Uses module | Via | Why |
|-------------|-----|-----|
| `gate` | implements `ControlPlaneReader`, `AuditSink` | is the SoR the gate reads for authz |
| `executor` | implements `BindingResolver`, `QueryCatalog`, `AuditSink` | supplies the dataset, table policy and report SQL |

External: `postgres` (Unlicense) — the driver, wrapped in `ControlPlaneDb` (COD-041).
