// Bridges the gate's QueryExecutor port to the executor module (#55) — the
// anti-corruption layer between two bounded contexts. Each side keeps its own
// vocabulary; this file is the only place they meet.
//
// Responsibility split follows 原則E:
//   ① tenant boundary  → the executor resolves the dataset itself; we never
//                        pass it, so a gate bug cannot redirect the warehouse.
//   ② row scope        → the gate owns it (derived from roles, and already
//                        folded into the cache key), so we hand it over rather
//                        than let the executor derive it a second time and
//                        risk disagreeing with the key the result is stored under.
import type { AuthzContext, DataScope as GateScope } from '../domain/types.ts';
import type { QueryExecutor } from '../application/ports.ts';
import type { ExecuteQuery } from '../../executor/application/execute.ts';
import type { QueryCatalog } from '../../executor/application/ports.ts';
import type { DataScope as ExecutorScope } from '../../executor/domain/types.ts';

/** The two modules describe scope identically; restate it across the boundary. */
function toExecutorScope(scope: GateScope): ExecutorScope {
  return scope.kind === 'all' ? { kind: 'all' } : { kind: 'stores', storeIds: scope.storeIds };
}

export class ExecutorQueryAdapter implements QueryExecutor {
  readonly #execute: ExecuteQuery;
  readonly #catalog: QueryCatalog;

  constructor(deps: { execute: ExecuteQuery; catalog: QueryCatalog }) {
    this.#execute = deps.execute;
    this.#catalog = deps.catalog;
  }

  async execute(
    ctx: AuthzContext,
    queryId: string,
    params: Readonly<Record<string, string | number | boolean>>,
  ): Promise<
    | { readonly ok: true; readonly rows: readonly unknown[] }
    | { readonly ok: false; readonly status: 404 | 500; readonly reason: string }
  > {
    const sql = await this.#catalog.sqlFor(ctx.tenantId, queryId);
    if (sql === null) return { ok: false, status: 404, reason: 'unknown-query' };

    const result = await this.#execute.execute(
      ctx.tenantId,
      sql,
      params,
      toExecutorScope(ctx.scope),
    );
    if (result.ok) return { ok: true, rows: result.rows };

    // A refused query (400) means the *stored report SQL* violates policy —
    // the end user did not author it, so this is our bug, not their request.
    // It must not surface as a client error.
    const status = result.status === 404 ? 404 : 500;
    return { ok: false, status, reason: result.reason };
  }
}
