// HTTP routing + response mapping for the gate (ADR-0005 §7). Pure over a
// GateService — no platform bindings — so it is testable on Node with any
// adapter set. The Workers entry (worker.ts) supplies the wired GateService.
import type { GateService } from '../application/gate-service.ts';

const BEARER = /^Bearer (.+)$/;

function extractToken(req: Request): string | null {
  const match = req.headers.get('authorization')?.match(BEARER);
  return match ? (match[1] as string) : null;
}

// Denial reasons are audit-facing (MODULE.md) — never returned verbatim. The
// client sees only a generic message keyed by status.
const CLIENT_MESSAGE: Readonly<Record<number, string>> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  500: 'internal error',
};

function errorResponse(status: number): Response {
  return Response.json({ error: CLIENT_MESSAGE[status] ?? 'error' }, { status });
}

function queryParams(search: URLSearchParams): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of search) params[k] = v;
  return params;
}

/**
 * Routes:
 *   GET /health
 *   GET /r/{reportId}                     → ① shell (text/html)
 *   GET /r/{reportId}/data/{queryId}?...  → ② result (application/json)
 */
export function createHandler(gate: GateService): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const [root, reportId, sub, queryId] = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && root === 'health' && reportId === undefined) {
      return new Response('ok', { status: 200 });
    }
    if (req.method !== 'GET' || root !== 'r' || reportId === undefined) {
      return errorResponse(404);
    }

    const token = extractToken(req);
    if (token === null) return errorResponse(401);

    if (sub === undefined) {
      const res = await gate.requestShell(token, reportId);
      if (!res.ok) return errorResponse(res.status);
      return new Response(res.html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (sub === 'data' && queryId !== undefined) {
      const res = await gate.requestData(token, {
        reportId,
        queryId,
        params: queryParams(url.searchParams),
      });
      if (!res.ok) return errorResponse(res.status);
      return Response.json({ cached: res.cached, rows: res.rows }, { status: 200 });
    }

    return errorResponse(404);
  };
}
