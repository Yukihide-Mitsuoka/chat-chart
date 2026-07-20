// In-memory adapters — the ARC-005 second implementation. They keep the
// application layer runnable and testable without BigQuery, and stand in for
// the control plane until that module exists.
import type { QueryPolicy, TenantId } from '../domain/types.ts';
import type {
  AuditSink,
  BindingResolver,
  ParamValue,
  QueryRunner,
  TenantDataset,
} from '../application/ports.ts';

export class MemoryBindingResolver implements BindingResolver {
  readonly #bindings: ReadonlyMap<TenantId, TenantDataset>;
  readonly #policy: QueryPolicy;

  constructor(bindings: Record<TenantId, TenantDataset>, policy: QueryPolicy) {
    this.#bindings = new Map(Object.entries(bindings));
    this.#policy = policy;
  }

  async resolve(tenantId: TenantId): Promise<TenantDataset | null> {
    return this.#bindings.get(tenantId) ?? null;
  }

  async policyFor(): Promise<QueryPolicy> {
    return this.#policy;
  }
}

/**
 * Records the SQL it was asked to run and replays a canned result. Useful for
 * asserting *what* reached the warehouse — the point of the boundary work.
 */
export class RecordingQueryRunner implements QueryRunner {
  readonly calls: { sql: string; params: Record<string, ParamValue> }[] = [];
  #next: { ok: true; rows: readonly unknown[] } | { ok: false; reason: string } = {
    ok: true,
    rows: [],
  };

  willReturn(rows: readonly unknown[]): void {
    this.#next = { ok: true, rows };
  }
  willFail(reason: string): void {
    this.#next = { ok: false, reason };
  }

  async run(sql: string, params: Readonly<Record<string, ParamValue>>) {
    this.calls.push({ sql, params: { ...params } });
    return this.#next;
  }

  get lastSql(): string | undefined {
    return this.calls.at(-1)?.sql;
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

  actions(): readonly string[] {
    return this.events.map((e) => e.action);
  }
}
