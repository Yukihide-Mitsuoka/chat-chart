// In-memory adapters — the ARC-005 "current second adapter" mandated by
// ADR-0006 rule 1. They back the acceptance suite (and any local run) and
// keep the core portable off Cloudflare. TTL semantics mirror Workers KV
// minus its propagation delay (that delta is covered by design: ADR-0006
// consequences, revocation ≤60s).
import type { AuthzContext, RoleGrant, TenantId } from '../domain/types.ts';
import type {
  AuditSink,
  Clock,
  ControlPlaneReader,
  KeyValueStore,
  QueryExecutor,
} from '../application/ports.ts';

export class MemoryKv<T> implements KeyValueStore<T> {
  readonly #clock: Clock;
  readonly #entries = new Map<string, { value: T; expiresAt: number | null }>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async get(key: string): Promise<T | undefined> {
    const e = this.#entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.#clock.nowMs()) {
      this.#entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    this.#entries.set(key, {
      value,
      expiresAt: ttlMs === undefined ? null : this.#clock.nowMs() + ttlMs,
    });
  }

  /** Test/ops introspection — not part of the KeyValueStore port. */
  get size(): number {
    return this.#entries.size;
  }
  keys(): readonly string[] {
    return [...this.#entries.keys()];
  }
  delete(key: string): void {
    this.#entries.delete(key);
  }
}

export interface MemoryUser {
  readonly tenantId: TenantId;
  authEpoch: number;
  readonly roles: readonly string[];
}

/** Fixture-backed control plane (stand-in for Postgres — 原則D). */
export class MemoryControlPlane implements ControlPlaneReader {
  readonly tenants: Map<TenantId, { authEpoch: number }>;
  readonly users: Map<string, MemoryUser>;
  readonly roles: Map<TenantId, Map<string, RoleGrant>>;
  readonly reports: Map<TenantId, Map<string, { reportVersion: number }>>;
  readonly dataVersions: Map<TenantId, number>;

  constructor(seed: {
    tenants: Record<TenantId, { authEpoch: number }>;
    users: Record<string, MemoryUser>;
    roles: Record<TenantId, Record<string, RoleGrant>>;
    reports: Record<TenantId, Record<string, { reportVersion: number }>>;
    dataVersions: Record<TenantId, number>;
  }) {
    this.tenants = new Map(Object.entries(seed.tenants));
    this.users = new Map(Object.entries(seed.users));
    this.roles = new Map(
      Object.entries(seed.roles).map(([t, r]) => [t, new Map(Object.entries(r))]),
    );
    this.reports = new Map(
      Object.entries(seed.reports).map(([t, r]) => [t, new Map(Object.entries(r))]),
    );
    this.dataVersions = new Map(Object.entries(seed.dataVersions));
  }

  async getTenantEpoch(tenantId: TenantId): Promise<number | null> {
    return this.tenants.get(tenantId)?.authEpoch ?? null;
  }

  async getUser(tenantId: TenantId, userId: string) {
    const user = this.users.get(userId);
    if (!user) return null;
    const grants = user.roles
      .map((r) => this.roles.get(user.tenantId)?.get(r))
      .filter((g): g is RoleGrant => g !== undefined);
    return { tenantId: user.tenantId, authEpoch: user.authEpoch, grants };
  }

  async getReportVersion(tenantId: TenantId, reportId: string): Promise<number | null> {
    return this.reports.get(tenantId)?.get(reportId)?.reportVersion ?? null;
  }

  async getDataVersion(tenantId: TenantId): Promise<number> {
    return this.dataVersions.get(tenantId) ?? 0;
  }

  // -- write-side helpers (the future control-plane module's job; used by
  // -- tests and local admin flows) ------------------------------------------

  bumpDataVersion(tenantId: TenantId): void {
    this.dataVersions.set(tenantId, (this.dataVersions.get(tenantId) ?? 0) + 1);
  }

  bumpReportVersion(tenantId: TenantId, reportId: string): void {
    const report = this.reports.get(tenantId)?.get(reportId);
    if (report) report.reportVersion += 1;
  }

  /** Epoch bump — the SoR side of revocation (denylist write is the caller's). */
  revokeUser(userId: string): void {
    const user = this.users.get(userId);
    if (user) user.authEpoch += 1;
  }
}

/** Executor stand-in for the MCP gateway, over per-tenant datasets (原則C-3). */
export class MemoryExecutor implements QueryExecutor {
  readonly #data: ReadonlyMap<
    TenantId,
    readonly { store_id: string; category: string; amount: number }[]
  >;
  executorCalls = 0;

  constructor(
    data: Record<TenantId, readonly { store_id: string; category: string; amount: number }[]>,
  ) {
    this.#data = new Map(Object.entries(data));
  }

  async execute(ctx: AuthzContext, queryId: string) {
    this.executorCalls += 1;
    if (queryId !== 'q_sales_by_category')
      return { ok: false as const, status: 404 as const, reason: 'unknown-query' };
    let rows = this.#data.get(ctx.tenantId) ?? [];
    if (ctx.scope.kind === 'stores') {
      const ids = ctx.scope.storeIds;
      rows = rows.filter((r) => ids.includes(r.store_id));
    }
    const byCategory = new Map<string, number>();
    for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.amount);
    return {
      ok: true as const,
      rows: [...byCategory]
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly events: { tenantId: TenantId; action: string; detail: Record<string, string> }[] = [];
  async record(event: {
    tenantId: TenantId;
    action: string;
    detail: Readonly<Record<string, string>>;
  }): Promise<void> {
    this.events.push({ ...event, detail: { ...event.detail } });
  }
}
