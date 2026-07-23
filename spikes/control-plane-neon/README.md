# Spike: control-plane adapters on live Neon

Proves the Postgres control-plane adapters (`src/modules/control-plane`) read authz
correctly through RLS against the real Neon project — the counterpart to
`spikes/executor-bigquery` for the analytics side. Issue: #83.

## Run

```bash
node spikes/control-plane-neon/verify.mjs   # needs .env: DATABASE_URL, APP_RUNTIME_PASSWORD
```

Seeds two tenants as the owner, reads them back through `PgControlPlaneReader` /
`PgBindingResolver` / `PgAuditSink` as `app_runtime`, and tears the fixtures down.

## Result (2026-07-24) — 13/13

```
PASS  getTenantEpoch / getReportVersion(slug) / getDataVersion
PASS  getUser returns grants; scope from data_scope JSONB; reports resolve to slug
PASS  BindingResolver returns the tenant dataset; QueryCatalog resolves queryId → SQL
PASS  tenant A and B resolve DIFFERENT users for the same external_subject (RLS)
PASS  audit sink writes under tenant A; B cannot write an audit row for A (WITH CHECK)
```

The load-bearing one: both tenants seed a user with the **same** `external_subject`
('emb-user'), and the reader — scoped by `app.tenant_id` inside `withTenant` — returns
each tenant's own user and grants, never the other's. Tenant isolation is enforced by
the database, not by the query.

## Notes

- `app_runtime` has INSERT-only on `audit_logs` (the app writes the trail, never reads
  it — audit reads are an owner/admin operation), so the write-side isolation is what's
  checked, via the `WITH CHECK` policy.
- `tenants` FKs do not cascade on delete (off-boarding uses `status='closed'`, not hard
  delete); the spike cleans up children in FK order. Hard-delete-for-off-boarding is a
  separate schema decision (the §5 data-deletion requirement).
