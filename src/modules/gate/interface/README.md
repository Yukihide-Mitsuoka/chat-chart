# gate/interface

Inbound edge for the gate module.

- `handler.ts` — pure HTTP routing + response mapping over a `GateService`
  (`GET /health`, `GET /r/{reportId}` → ① shell, `GET /r/{reportId}/data/{queryId}` → ②
  result). Denial reasons stay audit-side; clients get a generic message per status.
- `worker.ts` — the Cloudflare Workers `fetch` entry (ADR-0006) and composition root:
  wires the real edge adapters (`WorkersKvStore`, `Es256TokenVerifier`, `WebCryptoHasher`)
  to `GateService`. The control-plane reader and query executor are in-memory `SEAM`
  bootstraps until the Postgres/MCP modules exist.

Run locally: `npx wrangler dev` (needs KV namespace ids and `VENDOR_KEYS` set — see
`wrangler.toml`). The handler and entry are covered on Node by `tests/modules/gate/`
without wrangler.
