// Postgres adapters implementing the ports the gate and executor already
// define. Every tenant-scoped read runs inside ControlPlaneDb.withTenant, so
// RLS is the backstop even if a query forgets a WHERE clause (LOG-0032).
import type { ControlPlaneReader } from '../../gate/application/ports.ts';
import type { TenantId } from '../../gate/domain/types.ts';
import type {
  BindingResolver,
  QueryCatalog,
  TenantDataset,
} from '../../executor/application/ports.ts';
import type { QueryPolicy } from '../../executor/domain/types.ts';
import { rowsToGrants, type RoleRow } from './mapping.ts';
import type { ControlPlaneDb } from './pg.ts';

/** Gate's ControlPlaneReader over Postgres. userId is the JWT sub = external_subject. */
export class PgControlPlaneReader implements ControlPlaneReader {
  readonly #db: ControlPlaneDb;
  constructor(db: ControlPlaneDb) {
    this.#db = db;
  }

  async getTenantEpoch(tenantId: TenantId): Promise<number | null> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx<{ auth_epoch: number }[]>`select auth_epoch from tenants`;
      return rows[0] ? Number(rows[0].auth_epoch) : null;
    });
  }

  async getUser(tenantId: TenantId, userId: string) {
    return this.#db.withTenant(tenantId, async (tx) => {
      const users = await tx<{ id: string; auth_epoch: number }[]>`
        select id, auth_epoch from users where external_subject = ${userId}`;
      const user = users[0];
      if (!user) return null;
      const roleRows = await tx<RoleRow[]>`
        select r.data_scope,
               coalesce(
                 array_agg(rep.slug) filter (where rep.slug is not null),
                 '{}'
               ) as reports
        from user_roles ur
        join roles r on r.id = ur.role_id
        left join role_reports rr on rr.role_id = r.id
        left join reports rep on rep.id = rr.report_id
        where ur.user_id = ${user.id}
        group by r.id, r.data_scope`;
      return { tenantId, authEpoch: Number(user.auth_epoch), grants: rowsToGrants(roleRows) };
    });
  }

  async getReportVersion(tenantId: TenantId, reportId: string): Promise<number | null> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx<{ report_version: number }[]>`
        select report_version from reports where slug = ${reportId}`;
      return rows[0] ? Number(rows[0].report_version) : null;
    });
  }

  async getDataVersion(tenantId: TenantId): Promise<number> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx<{ data_version: number }[]>`
        select coalesce(max(data_version), 0) as data_version from datasources`;
      return rows[0] ? Number(rows[0].data_version) : 0;
    });
  }
}

/**
 * Executor's BindingResolver + QueryCatalog over Postgres. The ① dataset comes
 * from the tenant's datasource row (never the caller). The table allowlist
 * (QueryPolicy) is injected: Phase 1 has one datasource shape, so storing it
 * per-tenant would be speculative (COD-051) — it becomes a table when a second
 * shape appears.
 */
export class PgBindingResolver implements BindingResolver, QueryCatalog {
  readonly #db: ControlPlaneDb;
  readonly #policy: QueryPolicy;
  constructor(db: ControlPlaneDb, policy: QueryPolicy) {
    this.#db = db;
    this.#policy = policy;
  }

  async resolve(tenantId: TenantId): Promise<TenantDataset | null> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx<{ dataset: string }[]>`
        select dataset from datasources where status = 'active' order by created_at limit 1`;
      return rows[0] ? { tenantId, dataset: rows[0].dataset } : null;
    });
  }

  async policyFor(): Promise<QueryPolicy> {
    return this.#policy;
  }

  async sqlFor(tenantId: TenantId, queryId: string): Promise<string | null> {
    return this.#db.withTenant(tenantId, async (tx) => {
      const rows = await tx<{ sql_text: string }[]>`
        select sql_text from report_queries where query_id = ${queryId}`;
      return rows[0]?.sql_text ?? null;
    });
  }
}

/** Writes audit_logs. Satisfies both the gate's and the executor's AuditSink shape. */
export class PgAuditSink {
  readonly #db: ControlPlaneDb;
  constructor(db: ControlPlaneDb) {
    this.#db = db;
  }

  async record(event: {
    readonly tenantId: TenantId;
    readonly action: string;
    readonly detail: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.#db.withTenant(event.tenantId, async (tx) => {
      await tx`insert into audit_logs (tenant_id, action, detail)
               values (${event.tenantId}, ${event.action}, ${tx.json(event.detail)})`;
    });
  }
}
