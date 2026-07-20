// Inbound HTTP for the executor service (ADR-0005 §7: gate → HTTP → MCP).
//
// TRUST BOUNDARY. Over the wire the caller asserts a tenantId and a row scope,
// so this handler MUST establish that the caller really is our gate before
// believing either — otherwise anyone who can reach this endpoint impersonates
// any tenant with any scope. A shared service secret does that; the ① tenant
// boundary itself is still resolved here from tenantId (never sent by the
// caller), so an authenticated-but-buggy gate still cannot name a dataset.
import type { DataScope } from '../domain/types.ts';
import type { ExecuteQuery } from '../application/execute.ts';
import type { ParamValue, QueryCatalog } from '../application/ports.ts';

export interface ExecutorHttpDeps {
  readonly execute: ExecuteQuery;
  readonly catalog: QueryCatalog;
  /** Shared secret proving the caller is the gate. Never logged or echoed. */
  readonly serviceToken: string;
}

/** Constant-time comparison — a length-or-prefix leak would weaken the secret. */
function secretsMatch(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Compare a fixed number of bytes so the loop count never depends on input.
  let diff = left.length ^ right.length;
  const span = Math.max(left.length, right.length);
  for (let i = 0; i < span; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the wire scope. Unknown shapes are refused, never coerced open. */
function parseScope(raw: unknown): DataScope | null {
  if (!isRecord(raw)) return null;
  if (raw['kind'] === 'all') return { kind: 'all' };
  if (raw['kind'] === 'stores') {
    const ids = raw['storeIds'];
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string')) return null;
    return { kind: 'stores', storeIds: ids as string[] };
  }
  return null;
}

function parseParams(raw: unknown): Record<string, ParamValue> | null {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return null;
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
    out[k] = v;
  }
  return out;
}

const json = (body: unknown, status: number): Response =>
  Response.json(body as Record<string, unknown>, { status });

/**
 * POST /v1/query
 *   { tenantId, queryId, params?, scope }  →  { rows }
 * Failures return { error } with a generic reason; detail stays in the audit log.
 */
export function createExecutorHandler(deps: ExecutorHttpDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return new Response('ok');
    if (req.method !== 'POST' || url.pathname !== '/v1/query')
      return json({ error: 'not found' }, 404);

    const presented = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (presented === undefined || !secretsMatch(presented, deps.serviceToken))
      return json({ error: 'unauthorized' }, 401);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad request' }, 400);
    }
    if (!isRecord(body)) return json({ error: 'bad request' }, 400);

    const tenantId = body['tenantId'];
    const queryId = body['queryId'];
    const scope = parseScope(body['scope']);
    const params = parseParams(body['params']);
    if (
      typeof tenantId !== 'string' ||
      typeof queryId !== 'string' ||
      scope === null ||
      params === null
    )
      return json({ error: 'bad request' }, 400);

    const sql = await deps.catalog.sqlFor(tenantId, queryId);
    if (sql === null) return json({ error: 'unknown query' }, 404);

    const result = await deps.execute.execute(tenantId, sql, params, scope);
    if (result.ok) return json({ rows: result.rows }, 200);
    return json({ error: result.reason }, result.status === 404 ? 404 : 500);
  };
}
