// Ports the executor needs from outside (ARC-002: dependencies point inward).
// Two implementations are expected (ARC-005): the BigQuery adapter and the
// in-memory adapter that backs tests and local runs.
import type { QueryPolicy, TenantId } from '../domain/types.ts';

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

/**
 * Where a tenant's data physically lives — the ① tenant boundary (原則E①).
 * Infrastructure facts only: no row scope here, because that is authorization
 * (原則E②) and is supplied per call by the layer that derived it from roles.
 * A connected (customer-owned) warehouse adds projectId + a credential
 * reference here; hosted vs connected is config, not code (ADR-0005 §9.2).
 */
export interface TenantDataset {
  readonly tenantId: TenantId;
  readonly dataset: string;
}

/** Where a tenant's queryable surface comes from (control plane, 原則D). */
export interface BindingResolver {
  resolve(tenantId: TenantId): Promise<TenantDataset | null>;
  policyFor(tenantId: TenantId): Promise<QueryPolicy>;
}

/**
 * Resolves a report's query id to its SQL text (control plane, ADR-0005 §5).
 * The caller never supplies SQL: both transports pass a queryId, so the stored
 * report definition is the only source of the statement that gets bound.
 */
export interface QueryCatalog {
  sqlFor(tenantId: TenantId, queryId: string): Promise<string | null>;
}

export interface AuditSink {
  record(event: {
    readonly tenantId: TenantId;
    readonly action: string;
    readonly detail: Readonly<Record<string, string>>;
  }): Promise<void>;
}
