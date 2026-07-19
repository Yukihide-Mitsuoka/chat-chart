// Ports the executor needs from outside (ARC-002: dependencies point inward).
// Two implementations are expected (ARC-005): the BigQuery adapter and the
// in-memory adapter that backs tests and local runs.
import type { QueryPolicy, TenantBinding, TenantId } from '../domain/types.ts';

/** A named query parameter value. Values are never interpolated into SQL. */
export type ParamValue = string | number | boolean;

/**
 * Runs already-bound SQL. Implementations MUST pass `params` as native query
 * parameters — string interpolation here would undo the AST binding.
 */
export interface QueryRunner {
  run(
    sql: string,
    params: Readonly<Record<string, ParamValue>>,
  ): Promise<
    | { readonly ok: true; readonly rows: readonly unknown[] }
    | { readonly ok: false; readonly reason: string }
  >;
}

/** Where a tenant's queryable surface comes from (control plane, 原則D). */
export interface BindingResolver {
  resolve(tenantId: TenantId): Promise<TenantBinding | null>;
  policyFor(tenantId: TenantId): Promise<QueryPolicy>;
}

export interface AuditSink {
  record(event: {
    readonly tenantId: TenantId;
    readonly action: string;
    readonly detail: Readonly<Record<string, string>>;
  }): Promise<void>;
}
