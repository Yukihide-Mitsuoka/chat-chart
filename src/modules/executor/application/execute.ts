// The execute use case (ADR-0005 §7, MCP step): resolve the tenant's binding,
// compile the boundary into the SQL, run it, and audit what actually ran.
//
// Order matters and is load-bearing: nothing reaches the runner that has not
// been through bindQuery, and the binding comes from the control plane keyed by
// a server-resolved tenantId — never from the caller (原則B).
import { bindQuery } from '../domain/bind.ts';
import type { DataScope, TenantBinding, TenantId } from '../domain/types.ts';
import type { AuditSink, BindingResolver, ParamValue, QueryRunner } from './ports.ts';

export type ExecuteFailure = {
  readonly ok: false;
  /** 400: the query was refused. 404: unknown tenant. 500: execution failed. */
  readonly status: 400 | 404 | 500;
  readonly reason: string;
};
export type ExecuteResult =
  { readonly ok: true; readonly rows: readonly unknown[]; readonly sql: string } | ExecuteFailure;

export interface ExecuteDeps {
  readonly bindings: BindingResolver;
  readonly runner: QueryRunner;
  readonly audit: AuditSink;
}

export class ExecuteQuery {
  readonly #d: ExecuteDeps;

  constructor(deps: ExecuteDeps) {
    this.#d = deps;
  }

  /**
   * @param tenantId server-resolved (from the gate's verified context)
   * @param sql      the report's query, as authored — unbound
   * @param params   named query parameters, passed through to the runner
   * @param scope    the caller's row scope. Required, and supplied by the
   *   authorization layer that derived it from the principal's roles (原則E②).
   *   Deliberately NOT resolved here: the gate already computes this scope to
   *   build its cache key, and a second derivation could disagree with it —
   *   which would cache rows under a key claiming a different visibility.
   *   The executor stays authoritative for the ① tenant boundary (the dataset),
   *   which it resolves itself and never accepts from the caller.
   */
  async execute(
    tenantId: TenantId,
    sql: string,
    params: Readonly<Record<string, ParamValue>>,
    scope: DataScope,
  ): Promise<ExecuteResult> {
    const dataset = await this.#d.bindings.resolve(tenantId);
    if (dataset === null) return { ok: false, status: 404, reason: 'unknown-tenant' };
    // Defence in depth: a resolver bug that returns another tenant's dataset
    // would silently redirect the query, so refuse the mismatch outright.
    if (dataset.tenantId !== tenantId)
      return { ok: false, status: 500, reason: 'binding-tenant-mismatch' };

    const policy = await this.#d.bindings.policyFor(tenantId);
    const binding: TenantBinding = { ...dataset, scope };
    const bound = bindQuery(sql, binding, policy);
    if (!bound.ok) {
      await this.#audit(tenantId, 'query.refused', {
        code: bound.code,
        detail: bound.detail,
      });
      return { ok: false, status: 400, reason: bound.code };
    }

    const result = await this.#d.runner.run(bound.sql, params);
    if (!result.ok) {
      await this.#audit(tenantId, 'query.failed', { reason: result.reason });
      return { ok: false, status: 500, reason: 'execution-failed' };
    }

    // Audit the SQL that actually ran, not what was submitted — the bound form
    // is the evidence that the boundary was applied.
    await this.#audit(tenantId, 'query.execute', {
      sql: bound.sql,
      tables: bound.tables.join(','),
    });
    return { ok: true, rows: result.rows, sql: bound.sql };
  }

  async #audit(
    tenantId: TenantId,
    action: string,
    detail: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.#d.audit.record({ tenantId, action, detail });
    } catch {
      // An audit-sink outage must not fail a request that already succeeded,
      // nor mask the original refusal. Surfacing this is the sink's job.
    }
  }
}
