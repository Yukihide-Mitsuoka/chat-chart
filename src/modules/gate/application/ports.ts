// Ports the gate needs from the outside world (ARC-002: dependencies point
// inward — infrastructure implements these). Kept few and deep (ARC-005):
// the in-memory adapters (tests) and the Workers adapters (production) are
// the two implementations.
import type { AuthzContext, RoleGrant, TenantId, TokenClaims } from '../domain/types.ts';

/** Verifies the vendor-signed embed JWT (signature, exp, aud). */
export interface TokenVerifier {
  verify(
    token: string,
    nowMs: number,
  ): Promise<
    | { readonly ok: true; readonly claims: TokenClaims }
    | { readonly ok: false; readonly reason: string }
  >;
}

/** Read-side of the control plane (SoR: Postgres — ADR-0005 原則D). */
export interface ControlPlaneReader {
  getTenantEpoch(tenantId: TenantId): Promise<number | null>;
  getUser(
    tenantId: TenantId,
    userId: string,
  ): Promise<{
    readonly tenantId: TenantId;
    readonly authEpoch: number;
    readonly grants: readonly RoleGrant[];
  } | null>;
  getReportVersion(tenantId: TenantId, reportId: string): Promise<number | null>;
  getDataVersion(tenantId: TenantId): Promise<number>;
}

/** Generic TTL'd KV — backs ② result, ③ authz, and denylist stores. */
export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlMs?: number): Promise<void>;
}

/** Executes a query via the MCP gateway (which enforces tenant injection). */
export interface QueryExecutor {
  execute(
    ctx: AuthzContext,
    queryId: string,
    params: Readonly<Record<string, string | number | boolean>>,
  ): Promise<
    | { readonly ok: true; readonly rows: readonly unknown[] }
    | { readonly ok: false; readonly status: 404 | 500; readonly reason: string }
  >;
}

export interface Hasher {
  sha256hex(input: string): Promise<string>;
}

export interface AuditSink {
  record(event: {
    readonly tenantId: TenantId;
    readonly action: string;
    readonly detail: Readonly<Record<string, string>>;
  }): Promise<void>;
}

export interface Clock {
  nowMs(): number;
}

/** Cached ② entry: payload carries its tenant for the 原則C-4 self-check. */
export interface ResultPayload {
  readonly tenantId: TenantId;
  readonly rows: readonly unknown[];
}

/** Cached ③ entry. */
export interface AuthzEntry {
  readonly ctx: AuthzContext;
}
