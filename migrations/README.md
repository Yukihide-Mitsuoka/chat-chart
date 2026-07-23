# migrations

Control-plane schema for Neon Postgres (system-design.md §3). Plain SQL applied
in filename order by a zero-dependency runner; each file runs once, tracked in
`schema_migrations`.

## Setup (once)

Put the connection string in a **gitignored** `.env` at the repo root — never in
git, never in chat (GR-001):

```
DATABASE_URL=postgresql://neondb_owner:<password>@ep-...-pooler.<region>.aws.neon.tech/neondb?sslmode=require
APP_RUNTIME_PASSWORD=<generate a fresh 16+ char secret; this is NOT the neondb_owner password>
```

`app_runtime` is the least-privilege role the application connects as — the only
principal RLS constrains (the owner/superuser bypasses it). Give it its own
password, distinct from `neondb_owner`.

## Run

```bash
node migrations/run.mjs --status   # show applied / pending, change nothing
node migrations/run.mjs            # apply pending migrations
```

The runner rewrites the Neon **pooler** host to the **direct** endpoint (DDL
through transaction pooling is unreliable) and never prints credentials or the
`ALTER ROLE` statement.

## Files

| File | Purpose |
|------|---------|
| `001_control_plane_schema.sql` | tables (§3.2) with composite `(tenant_id, id)` FKs |
| `002_rls_and_app_role.sql` | uniform `enable`+`force` RLS + `USING`/`WITH CHECK`, the `app_runtime` role and its least-privilege grants |
| `003_seed_permission_catalog.sql` | the fixed permission vocabulary (原則E②) |

RLS mechanics are proven on stock Postgres 16 (`spikes/rls-isolation`, LOG-0032);
Neon runs stock Postgres, so behavior is identical. The `src/modules/control-plane`
adapters (#83) connect as `app_runtime` and `SET app.tenant_id` per request.
