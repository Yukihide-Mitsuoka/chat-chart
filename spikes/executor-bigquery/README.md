# Spike: executor over live BigQuery — tenant isolation, end to end

Closes the "NOT YET VERIFIED" caveat from PR #59. Runs the **real** pipeline —
`ExecuteQuery` → `bindQuery` (AST boundary) → `BigQueryRunner` (REST `jobs.query` + ADC)
— against two real per-tenant datasets, and measures that a tenant can only ever read its
own data. Issue: #55.

## Setup (one-time, owner-approved 2026-07-20)

`setup.mjs` created two datasets in `kotonoha-bi-dev` with KB-scale seed rows (free tier):

- `t_alpha.orders` — 5 rows across stores s1/s2 (total 157,900)
- `t_bravo.orders` — 3 rows in store s9 (total 39,500)

```bash
node spikes/executor-bigquery/setup.mjs    # needs `gcloud auth application-default login`
```

## Result (2026-07-20) — 7/7 through the real pipeline

```bash
node spikes/executor-bigquery/verify.mjs
```

```
PASS  alpha total = 157900 (own data only)
PASS  bravo total = 39500 (own data only)
PASS  alpha bound SQL targets t_alpha
PASS  bravo bound SQL targets t_bravo
PASS  alpha querying t_bravo.orders is refused pre-execution
PASS  store-scoped alpha sees only s1 rows: 65000
PASS  named param filters live rows (amount>=30000 -> 3)
```

The load-bearing ones: **identical SQL** (`SELECT ... FROM orders GROUP BY category`) run
by `t_alpha` and `t_bravo` returns each tenant's own totals from its own dataset, and an
explicit `SELECT * FROM t_bravo.orders` from the alpha tenant is **refused before any
BigQuery call** (`qualified-table-not-allowed`). Named parameters and row scope both work
on live data.

This makes ADR-0005 §10-6 concrete: **per-tenant datasets** are a working isolation
mechanism for the analytics side, verified end to end.

## Authentication — this spike vs. production (open design question)

This spike authenticates with **ADC as the developer's own account**, querying datasets
*we host* in `kotonoha-bi-dev`. That is fine for the "ChatChart hosts the analytics data"
model, but it does **not** answer how to query a **customer's own** BigQuery/warehouse,
where ADC-as-us has no access. That provenance choice is ADR-0005 §10-7, still open, and
the auth mechanism follows from it:

- **Hosted (ChatChart owns the data)** — ADC / a ChatChart service account, exactly as
  here. Per-tenant datasets in our project.
- **Connected (customer owns the warehouse)** — the customer grants access to a
  ChatChart-provided service-account email (BigQuery `roles/bigquery.dataViewer` on their
  dataset), and the `BindingResolver` hands back that customer's project/dataset +
  credential reference (stored in the control plane as a Secret Manager reference, never
  in the repo — GR-001). ADC-as-developer is **not** the production path here.

The executor is already shaped for both: `TenantBinding.dataset` and the runner's
`projectId`/token provider are per-call inputs, so "whose warehouse, whose credential" is
a `BindingResolver` concern, not a code change. Deciding hosted vs connected (and likely
supporting both) waits on a design partner's actual data shape — the same gate as §10-6/7.

## Not committed

`t_alpha` / `t_bravo` live only in `kotonoha-bi-dev` for this measurement; `setup.mjs` is
idempotent (`CREATE OR REPLACE`) if they need rebuilding. These are throwaway fixtures,
not production schema.
