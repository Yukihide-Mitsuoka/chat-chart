// Satisfies the gate's QueryExecutor port by calling the executor service over
// HTTP — the production Workers topology (ADR-0005 §7). fetch-based so it runs
// on Workers, where the in-process executor cannot (its credentials come from
// google-auth-library, which is Node-only).
//
// We send tenantId and the gate-derived row scope; the service authenticates us
// with a shared secret before trusting either. We never send a dataset: the ①
// tenant boundary stays the executor's to resolve (原則E).
import type { AuthzContext } from '../domain/types.ts';
import type { QueryExecutor } from '../application/ports.ts';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface HttpQueryExecutorOptions {
  /** Base URL of the executor service, e.g. https://executor.internal */
  readonly baseUrl: string;
  /** Shared secret proving we are the gate. Never logged. */
  readonly serviceToken: string;
  readonly fetchImpl?: FetchLike;
}

export class HttpQueryExecutor implements QueryExecutor {
  readonly #o: HttpQueryExecutorOptions;
  readonly #fetch: FetchLike;

  constructor(options: HttpQueryExecutorOptions) {
    this.#o = options;
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async execute(
    ctx: AuthzContext,
    queryId: string,
    params: Readonly<Record<string, string | number | boolean>>,
  ): Promise<
    | { readonly ok: true; readonly rows: readonly unknown[] }
    | { readonly ok: false; readonly status: 404 | 500; readonly reason: string }
  > {
    let status: number;
    let raw: string;
    try {
      const res = await this.#fetch(`${this.#o.baseUrl.replace(/\/$/, '')}/v1/query`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#o.serviceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tenantId: ctx.tenantId,
          queryId,
          params,
          scope: ctx.scope,
        }),
      });
      status = res.status;
      raw = await res.text();
    } catch {
      // Deliberately opaque: a transport message can carry internal hostnames.
      return { ok: false, status: 500, reason: 'executor-unreachable' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, status: 500, reason: 'executor-bad-response' };
    }
    const body = (parsed ?? {}) as { rows?: unknown; error?: unknown };

    if (status === 200) {
      if (!Array.isArray(body.rows))
        return { ok: false, status: 500, reason: 'executor-bad-response' };
      return { ok: true, rows: body.rows as readonly unknown[] };
    }
    if (status === 404) return { ok: false, status: 404, reason: 'unknown-query' };
    // 401 here means OUR service token is wrong — an operator error, not the
    // caller's, so it must not surface as anything the end user can act on.
    return {
      ok: false,
      status: 500,
      reason: typeof body.error === 'string' ? body.error : `executor-error-${status}`,
    };
  }
}
