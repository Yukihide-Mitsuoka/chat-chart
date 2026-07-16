# NL→SQL accuracy spike — real messy schema (BigQuery thelook_ecommerce)

Follow-up to [`spikes/nl2sql-accuracy/`](../nl2sql-accuracy/) (synthetic schema, 12/12).
Validates the same pipeline against a public dataset **we did not design**:
[`bigquery-public-data.thelook_ecommerce`](https://console.cloud.google.com/marketplace/product/bigquery-public-data/thelook-ecommerce).

## Why this dataset

Retail shape matching the product (orders / order_items / products / users + noise
tables), with the real-world traps the synthetic rig couldn't provide:

| Trap | In thelook |
|---|---|
| Multiple date columns | `created_at` / `shipped_at` / `delivered_at` / `returned_at`, all nullable |
| Multiple price columns | `order_items.sale_price` vs `products.retail_price` vs `products.cost` |
| Ambiguous dimensions | `category` vs `department`; denormalized `inventory_items.product_*` |
| Free-text statuses | Cancelled / Complete / Processing / Returned / Shipped |
| Dialect | BigQuery standard SQL + mandatory full table qualification |
| Noise tables | `events` (2.4M rows), `inventory_items` (490K) must be ignored/selected correctly |

**Scope: accuracy only.** Tenant isolation is not testable here (single-tenant data)
and stays on the synthetic rig — deliberate division of labor.

## Method

- 12 Japanese BI questions targeting the traps (10 SQL + 2 must-clarify).
- Verification: **SQL-vs-SQL, same run** — hand-written gold SQL and model SQL both
  execute against BigQuery in the same session (thelook is a *living* dataset;
  cross-day caching would drift).
- Guards: SELECT-only, thelook-only table refs, `maximum_bytes_billed` = 200MB.

## Run

```sh
../nl2sql-accuracy/.venv/bin/python run_thelook.py --project <gcp-project>
# options: --model, --provider anthropic (Opus 4.8 fallback per model policy)
```

Requires GCP ADC (`gcloud auth application-default login`) with Vertex AI and
BigQuery access.

## Results (2026-07-17, gemini-3.5-flash)

- **Run 1: 11/12.** Only T5 failed — the model correctly chose `delivered_at`
  (the intended trap) but **silently added `status='Complete'`**, excluding 584
  delivered-then-returned orders. Failure mode: *unrequested filter narrowing*.
- **Fix: one general prompt rule** ("don't add filters not required by the rules
  or the question; event questions filter by the event's date column only") —
  not benchmark-specific.
- **Run 2: 12/12 PASS. ~¥0.10/question** (estimate — confirm on GCP billing).

This followed the model policy exactly: prompt improvement first; the Opus 4.8
fallback was never needed.

## Honest limits

- thelook is realistic but still synthetic-fictional and clean-typed; a design
  partner's actual schema is the final validation step.
- Question set + business rules were designed alongside the gold SQL (though the
  schema wasn't ours). Gold SQL is hand-written and could share a misreading with
  the grader's intent — mitigated by trap-targeted design and manual review.
- Single run per condition, temperature=0.
