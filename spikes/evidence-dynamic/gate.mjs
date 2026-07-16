// Minimal "authorization gate" prototype for the shell/data-separation experiment.
//
// Serves the Evidence-built static SHELL from app/build/, but for the tenant
// DATA path it decides — per request, from a header — which tenant's parquet
// bytes to return. Same shell, different data, no rebuild. This stands in for
// the real MCP gate that would resolve tenant_id from the session and return
// tenant-scoped data (ADR-0005).
//
// Usage: node gate.mjs <build_dir> <data_url_prefix> <tenantA_dir> <tenantB_dir>
//   e.g. node gate.mjs app/build /data/ data/tenant_a data/tenant_b
// Pick tenant with:  curl -H 'x-tenant: b' http://localhost:8799/<data_url>

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const [buildDir, dataPrefix, tenantADir, tenantBDir] = process.argv.slice(2);
if (!buildDir || !dataPrefix) {
  console.error("usage: node gate.mjs <build_dir> <data_url_prefix> <tenantA_dir> <tenantB_dir>");
  process.exit(1);
}
const TENANT_DIR = { a: tenantADir, b: tenantBDir };

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".parquet": "application/octet-stream",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".map": "application/json",
  ".woff2": "font/woff2", ".txt": "text/plain",
};

function safeJoin(root, urlPath) {
  const p = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, p);
  if (!full.startsWith(normalize(root))) return null; // traversal guard
  return full;
}

const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split("?")[0];

  // resolve tenant from (priority) x-tenant header → tenant cookie → default 'a'.
  // In production this is the MCP gate reading tenant_id from the session; here
  // the cookie lets a plain browser navigation pick a tenant, and the header
  // lets curl prove the same URL returns different bytes per tenant.
  // FINDING: Evidence ships a data-caching service worker. For dynamic
  // per-tenant data it must be disabled or made tenant-aware (otherwise SW
  // serves tenant A's cached data to tenant B). Here the gate refuses to serve
  // it so the browser can't register it, and the parquet fetch reaches us live.
  if (/service-worker/i.test(urlPath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("gate: service worker disabled for dynamic-data test");
  }

  const cookie = (req.headers.cookie || "").match(/(?:^|;\s*)tenant=([ab])/i);
  const pickTenant = () =>
    (req.headers["x-tenant"] || (cookie && cookie[1]) || "a").toString().toLowerCase();

  // --- the gate: tenant DATA path is resolved per-request, not baked ---
  if (dataPrefix !== "-" && urlPath.startsWith(dataPrefix)) {
    const tenant = pickTenant();
    console.log(`[data] ${urlPath} cookie=${JSON.stringify(req.headers.cookie || "")} `
      + `x-tenant=${req.headers["x-tenant"] || "-"} -> served tenant=${tenant}`);
    const root = TENANT_DIR[tenant] || TENANT_DIR.a;
    const rel = urlPath.slice(dataPrefix.length);
    const file = safeJoin(root, rel);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "x-served-tenant": tenant, "cache-control": "no-store",
      });
      return res.end(body);
    } catch {
      res.writeHead(404); return res.end(`gate: no data for tenant=${tenant} at ${rel}`);
    }
  }

  // --- the shell: plain static file serving from the Evidence build ---
  let file = safeJoin(buildDir, urlPath);
  if (!file) { res.writeHead(400); return res.end("bad path"); }
  try {
    let s = await stat(file);
    if (s.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    // SPA fallback
    try {
      const body = await readFile(join(buildDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    } catch { res.writeHead(404); res.end("not found"); }
  }
});

server.listen(8799, () => console.log("gate on http://localhost:8799  (x-tenant: a|b)"));
