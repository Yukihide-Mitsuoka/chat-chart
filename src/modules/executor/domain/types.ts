// Core value types of the query executor (ADR-0005 原則C-2: the tenant boundary
// is forced into the SQL at the AST level, not appended as text).
// Pure layer: no I/O, no SQL engine calls, no imports from outside domain/.

export type TenantId = string;

/** Row-visibility scope, mirroring the gate's DataScope (ADR-0005 §6). */
export type DataScope =
  { readonly kind: 'all' } | { readonly kind: 'stores'; readonly storeIds: readonly string[] };

/**
 * What a tenant is allowed to query, resolved server-side before any SQL is
 * seen. `dataset` is the tenant's own BigQuery dataset — the physical isolation
 * boundary (ADR-0005 §9, per-tenant dataset).
 */
export interface TenantBinding {
  readonly tenantId: TenantId;
  readonly dataset: string;
  readonly scope: DataScope;
}

/**
 * One queryable table. `scopeColumn` names the column the row scope filters on;
 * tables without one are tenant-scoped but not row-scoped (e.g. dimensions).
 */
export interface TableRule {
  readonly name: string;
  readonly scopeColumn?: string;
}

/** The allowlist a query is checked against — nothing outside it is reachable. */
export interface QueryPolicy {
  readonly tables: readonly TableRule[];
}

export type RejectionCode =
  | 'parse-error'
  | 'not-a-single-statement'
  | 'not-a-select'
  | 'table-not-allowed'
  | 'qualified-table-not-allowed'
  | 'rewrite-failed';

export interface Rejection {
  readonly ok: false;
  readonly code: RejectionCode;
  readonly detail: string;
}

export interface BoundQuery {
  readonly ok: true;
  /** SQL with the tenant boundary compiled in; safe to execute as-is. */
  readonly sql: string;
  /** Physical tables actually referenced, after rewriting (for audit). */
  readonly tables: readonly string[];
}

export const reject = (code: RejectionCode, detail: string): Rejection => ({
  ok: false,
  code,
  detail,
});
