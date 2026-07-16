# Evidence dynamic-data integration spike (§8.8 / ADR-0005)

Resolves the last open architectural unknown from ADR-0005: can Evidence's
built dashboard **shell** be fed tenant-scoped data **at request time**,
instead of one build per tenant? This is the crux the whole shell/data
separation design (§4 of the ADR) rests on.

## What Evidence actually does (verified by dissecting a real build)

Scaffolded the official template (`npx degit evidence-dev/template`), built it
(`npm run sources && npm run build`), then inspected `build/` directly:

- Each data source compiles to a **content-addressed Parquet file**:
  `data/needful_things/orders/<hash>/orders.parquet`.
- `data/manifest.json` maps source name → that Parquet path.
- The page's SQL (`compiledQueryString`) **is** prerendered into the HTML —
  but the query **results are not**. Grepping the built HTML for actual
  values (category names, sales totals) found nothing; only the SQL text is
  embedded. So for a page with no client-only inputs, the numbers still come
  from a **runtime fetch** of the Parquet file, queried in-browser by
  DuckDB-WASM.
- Conclusion: **the shell (HTML/JS) and the data (Parquet, fetched by URL)
  are already separate artifacts** in Evidence's own build output. This is
  exactly the seam ADR-0005 needs.

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

## What could NOT be confirmed here (tool limitation, not a product finding)

The remaining link — does Evidence's own client-side reactivity correctly
**re-render** using freshly-fetched bytes on a plain page load — could not be
observed through this session's sandboxed preview-browser tool. Two
genuinely separate origins (`:8801` hardcoded to tenant A, `:8802` hardcoded
to tenant B — no shared cookies/storage possible) rendered **identical**
numbers in the tool's browser pane, even though `curl` against both origins
proved the byte content differs. That contradiction — same page in two
completely isolated origins showing identical output despite provably
different server responses — points at a caching/snapshot layer inside the
preview tool itself, not at Evidence or a real browser (which cannot share
state across origins by construction).

**This is flagged, not swept under the rug — do not read the identical
screenshots as "Evidence failed to update."** The HTTP-layer proof (§ above)
is the load-bearing result; the rendering confirmation is a fast follow-up:
open the same two `gate_fixed.mjs`-served URLs in a normal desktop browser
(two tabs, `:8801` and `:8802`) and eyeball whether the bar chart differs.
Low risk: re-fetching and re-rendering static-site data on a fresh page load
is core, well-exercised Evidence functionality, not custom code this project
would need to build.

## Reproduce

```sh
cd app && npm install && npm run sources && npm run build   # builds ./build
cd ..
node gate.mjs app/build /data/ data/tenant_a data/tenant_b   # cookie/header-switched, one origin
# or, to sidestep any client-side caching entirely:
node gate_fixed.mjs 8801 app/build /data/ data/tenant_a      # tenant A, fixed
node gate_fixed.mjs 8802 app/build /data/ data/tenant_b      # tenant B, fixed
curl -H 'x-tenant: b' http://localhost:8799/data/needful_things/orders/<hash>/orders.parquet | wc -c
```

## Answer to the spike question

**Yes — the dynamic-data seam is real.** Evidence's own build output already
separates a tenant-agnostic shell from a Parquet file fetched by URL at
runtime; an authorization gate can serve different tenant data through an
identical URL with zero rebuild. ADR-0005's shell/data separation is
implementable on top of Evidence as-is — no fork, no upstream patch needed.

Follow-ups before Phase 1 build starts:
- Confirm client-side re-render in a real desktop browser (see above).
- Design the actual gate's cache-key scheme (§ADR-0005 `scope_hash` /
  `data_version`) against this now-confirmed URL-interception mechanism.
- Decide how per-tenant Parquet gets produced at runtime (today: `evidence
  sources` at build time per-source; production needs an on-write pipeline
  that regenerates the tenant's Parquet on data change — this spike proved
  the *serving* side, not the *generation* side).
