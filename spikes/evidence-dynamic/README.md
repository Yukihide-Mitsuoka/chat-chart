# Evidence dynamic-data integration spike (§8.8 / ADR-0005)

Resolves the last open architectural unknown from ADR-0005: can Evidence's
built dashboard **shell** be fed tenant-scoped data **at request time**,
instead of one build per tenant? This is the crux the whole shell/data
separation design (§4 of the ADR) rests on.

## What Evidence actually does (verified by dissecting a real build)

> **Corrected 2026-07-17.** The first pass missed one channel; the request
> log of a full page load (below) surfaced it. Both channels matter.

Scaffolded the official template (`npx degit evidence-dev/template`), built it
(`npm run sources && npm run build`), inspected `build/`, and logged every
request a real page load makes. A built Evidence site has **two data
channels**, both fetched by URL at runtime, plus a data-free shell:

1. **Prerendered query results** — `api/prerendered_queries/<hash>.arrow`.
   At build time Evidence *executes* every page query and stores the result
   as an Arrow IPC file, keyed per query (`all-queries.json` maps
   `<query>_columns/_length/_data` → hash). **The initial render reads
   these** — this is where the numbers a user first sees come from.
   Being binary Arrow, they're invisible to text greps (the first pass
   grepped for raw values, found nothing in HTML/JS, and wrongly concluded
   results weren't prerendered anywhere).
2. **Source Parquet** — `data/<source>/<hash>/orders.parquet`, mapped by
   `data/manifest.json`. Fetched by the DuckDB-WASM **worker** (so it never
   shows up in main-thread performance entries) to hydrate the in-browser
   database for interactive re-queries — and, crucially, as the **fallback**
   compute path when a prerendered result is unavailable.
3. **The shell** (HTML/JS) carries the compiled SQL text but **zero data** —
   byte-identical across tenants (verified with `cmp` and bundle hashes).

So the seam ADR-0005 needs exists, but it is **two URLs wide, not one**:
a per-tenant gate must handle *both* the `.arrow` results and the Parquet.

## Experiment: same URL, different tenant bytes, no rebuild

Built `gate.mjs` — a tiny HTTP server that serves the built shell verbatim
but intercepts the `/data/` prefix and returns **different tenant's Parquet
bytes for the identical URL**, resolved per-request (stand-in for the real
MCP gate resolving `tenant_id` from the session).

Prepared two schema-identical Parquet files with visibly different content
(`data/tenant_a`, `data/tenant_b` — tenant B is a transformed subset: 3 vs 4
categories, ~4x smaller totals).

**Proven, at the HTTP layer, repeatedly and two ways:**

1. `curl` with different headers against the identical URL:
   ```
   x-tenant: a → 428224 bytes, x-served-tenant: a, totals: 4 categories / ¥346,976
   x-tenant: b → 471016 bytes, x-served-tenant: b, totals: 3 categories / ¥81,818
   ```
2. **A genuine in-page `fetch()`** executed inside the loaded Evidence page's
   own JS realm (not curl — the real browser, the real page, `credentials:
   "include"`, `cache: "no-store"`) against the same relative URL:
   ```json
   { "byteLength": 471016, "cookieSentByBrowser": "tenant=b", "x-served-tenant": "b" }
   ```

Byte-identical to the curl result. **The core claim is proven**: a single
built shell can be served against per-request, tenant-scoped data through an
authorization gate, with zero rebuild — the shell doesn't know or care which
tenant it's rendering.

Also confirmed: the shell's HTML is byte-for-byte identical regardless of
which tenant serves the data (`cmp` on both tenants' `/spike/` response —
0 differences, and the JS bundle hash matched too).

## The "identical render" mystery — resolved (2026-07-17 follow-up)

The first run of this spike hit a contradiction: two isolated origins
(`:8801` = tenant A, `:8802` = tenant B) provably served different Parquet
bytes, yet both rendered tenant A's numbers. The first writeup blamed a
preview-tool caching artifact. **That interpretation was wrong** — the
render was *correct behavior*: the displayed numbers never came from the
Parquet at all. They came from channel 1, the prerendered
`/api/prerendered_queries/*.arrow` results baked from tenant A's data at
build time, which the gate was happily serving from the shared shell
directory to both tenants. Swapping only the Parquet changes what
*interactive* queries would compute — not what the page initially shows.

(Verified directly: `09511413….arrow`, mapped to `sales_by_category_data`,
contains the tenant-A result rows; the per-request log shows the three
`.arrow` fetches preceding the Parquet fetch on every load.)

## Decisive experiment: per-tenant rendering, visually confirmed

`gate_fixed.mjs` gained a `noprerender` mode that **404s
`/api/prerendered_queries/*`** for that tenant, while still serving the
tenant's Parquet. Result, confirmed by screenshot in a real browser pane:

| Origin | Prerendered `.arrow` | Rendered chart+table |
|---|---|---|
| `:8801` tenant A | served (build default) | 4 categories, top **$157.9k** |
| `:8802` tenant B | **404** → client falls back to DuckDB-WASM over tenant B's Parquet | 3 categories, top **$39.5k** — exactly tenant B's data |

The request log corroborates: three `.arrow` requests → `[gate] 404ing…`
→ Parquet fetched → page computes and renders tenant B's numbers.
**Same shell build, different tenant data, no rebuild — visually proven.**

Two production options fall out of this, both compatible with ADR-0005:

- **Option 1 — 404-fallback (proven here):** gate serves tenant Parquet and
  404s prerendered results. Simple; costs first-paint latency (DuckDB-WASM
  init + compute before numbers appear) — the SLA-relevant tradeoff.
- **Option 2 — per-tenant result generation (faster paint):** the gate (or a
  worker behind it) executes the known compiled SQL against tenant data and
  serves tenant-scoped `.arrow` under the same hash URLs. This is exactly
  ADR-0005's "result cache" layer (`tenant_id:scope_hash:query_id:…`) —
  Evidence's prerendered-queries mechanism *is* that layer's native seam.

One more production note: Evidence registers a **data-caching service
worker** (`fix-tprotocol-service-worker.js`). Both gates 404 it in these
experiments; a multi-tenant deployment must disable it or make it
tenant-aware, or it will serve one tenant's cached data to another.

## Reproduce

`app/package-lock.json` and `app/.npmrc` are gitignored (not `.npmignore`d —
just not tracked in this repo) to keep the PR under GR-020's hard size gate;
`package-lock.json` alone was 17,662 of ~18,300 changed lines. `npm install`
regenerates it locally; exact dependency versions aren't load-bearing for a
one-off exploratory spike whose findings (README + committed evidence) don't
depend on them.

```sh
cd app && npm install && npm run sources && npm run build   # builds ./build
cd ..
node gate.mjs app/build /data/ data/tenant_a data/tenant_b   # cookie/header-switched, one origin
# or fixed-tenant origins; add `noprerender` to 404 the prerendered .arrow
# results and force client-side compute from that tenant's Parquet:
node gate_fixed.mjs 8801 app/build /data/ data/tenant_a               # tenant A, build default
node gate_fixed.mjs 8802 app/build /data/ data/tenant_b noprerender   # tenant B, dynamic
curl -H 'x-tenant: b' http://localhost:8799/data/needful_things/orders/<hash>/orders.parquet | wc -c
# open http://localhost:8801/spike and http://localhost:8802/spike side by side
```

## Answer to the spike question

**Yes — the dynamic-data seam is real, and it is now visually proven
end-to-end** (same shell build rendering different tenants' charts). The
corrected model: Evidence's build output separates **three** artifacts —
a data-free shell, per-query prerendered results (`.arrow`), and source
Parquet — all addressed by URL. A gate that controls the two data channels
fully controls what each tenant sees, with zero rebuild, no fork, no
upstream patch. The initially-planned "swap the Parquet" alone is **not
sufficient** — the prerendered-results channel is the one users see first,
and it maps 1:1 onto ADR-0005's result-cache layer.

Follow-ups before Phase 1 build starts:
- Choose Option 1 (404-fallback; simple, slower first paint) vs Option 2
  (per-tenant `.arrow` generation; fast paint, exactly ADR-0005's result
  cache) — measure first-paint latency of Option 1 to decide.
- Design the gate's cache-key scheme (`scope_hash` / `data_version`)
  against these two now-characterized URL channels.
- Decide how per-tenant Parquet (and, for Option 2, `.arrow` results) get
  produced on data change — this spike proved the *serving* side, not the
  *generation* side.
- Disable or tenant-scope Evidence's data-caching service worker.
