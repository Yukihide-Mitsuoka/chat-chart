# Spike: the full vertical slice on live data

Closes A-3 of #55 — the gate's executor SEAM is now wired to the real executor, and this
measures the whole path end to end: **vendor-signed JWT → gate authorization → AST tenant
binding → live BigQuery → ② result cache in KV**.

## Result (2026-07-20) — 8/8

```bash
node spikes/gate-executor-slice/verify.mjs   # needs gcloud ADC + the t_alpha fixture
```

```
PASS  shell served (① cache)
PASS  data served from live BigQuery
PASS  rows are the real t_alpha fixture (157900)
PASS  first call was a cache miss
PASS  second call hits the ② result cache
PASS  ② payload persisted to KV
PASS  cached rows equal the live rows
PASS  no token → 401

executor audit: query.execute
```

The audit line is the quiet proof of the cache doing its job: **one** `query.execute` for
two identical requests — the second was served from KV without touching BigQuery.

The `t_alpha` fixture comes from [`spikes/executor-bigquery/setup.mjs`](../executor-bigquery/README.md).

## Why this script exists (and is not the Workers entry)

`worker.ts` takes an optional `QueryExecutor` rather than constructing one, because the
two deployment shapes differ:

| Where | How the executor is reached |
|---|---|
| **This script (Node)** | in-process — the real `ExecuteQuery` + `BigQueryRunner` injected into `buildGate` |
| **Cloudflare Workers (production)** | gate → **HTTP** → executor service (ADR-0005 §7). ADC is Node-only, so credentials cannot live in the Worker |

So this is the Node composition root: it proves the seam and the data path for real, while
the Workers entry keeps its in-memory fallback until the HTTP executor client exists.

## Design note: which side owns the row scope

Wiring the two modules surfaced a correctness trap worth recording. Both sides had a
notion of row scope: the gate derives it from roles (and folds it into the ② cache key as
`scope_hash`), and the executor's `BindingResolver` also returned one. Two sources of
truth for the same fact means they can disagree — and a disagreement caches rows under a
key that claims a *different* visibility than the SQL actually enforced.

Resolved along 原則E:

- **① tenant boundary (dataset)** — the executor resolves it itself and never accepts it
  from the caller, so a gate bug cannot redirect the warehouse.
- **② row scope** — passed in by the gate, which owns authorization. `BindingResolver` now
  returns `TenantDataset` (infrastructure facts only); scope is a required argument to
  `ExecuteQuery.execute`, so it can never default open.
