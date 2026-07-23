// Postgres connection for the control plane, as the RLS-constrained app_runtime
// role (never the owner — the owner bypasses RLS). Node-only: the porsager
// driver uses TCP sockets, so this runs in a Node composition root. The Workers
// gate reaches the control plane over a transport instead (follow-up, mirrors
// the executor's #65).
import postgres from 'postgres';

export interface ControlPlaneDbOptions {
  /** Owner or pooler URL — only the host/db/params are used; user+password are replaced. */
  readonly databaseUrl: string;
  /** APP_RUNTIME_PASSWORD — the single source of truth for the app_runtime login. */
  readonly appPassword: string;
  readonly max?: number;
}

type Sql = postgres.Sql;
/** The transaction handle passed to withTenant callbacks. */
export type Tx = postgres.TransactionSql;

/**
 * Connects as app_runtime and runs tenant-scoped reads inside a transaction
 * that first sets `app.tenant_id`, so every RLS policy applies. The connection
 * targets the pooler host as given (runtime wants pooling); the migration
 * runner is the only thing that needs the direct endpoint.
 */
export class ControlPlaneDb {
  readonly #sql: Sql;

  constructor(opts: ControlPlaneDbOptions) {
    const u = new URL(opts.databaseUrl);
    u.username = 'app_runtime';
    u.password = opts.appPassword;
    this.#sql = postgres(u.toString(), { max: opts.max ?? 5, onnotice: () => {} });
  }

  /** Run fn with app.tenant_id set to tenantId (transaction-local), RLS active. */
  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  /** Untenanted access, for tables outside the tenant boundary (permissions, vendor_keys). */
  get sql(): Sql {
    return this.#sql;
  }

  end(): Promise<void> {
    return this.#sql.end();
  }
}
