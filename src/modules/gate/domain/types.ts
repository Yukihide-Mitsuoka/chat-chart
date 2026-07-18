// Core value types of the edge authorization gate (ADR-0005 §2, ADR-0006).
// This layer is pure: no I/O, no platform APIs, no imports from outside domain/.

export type TenantId = string;

/**
 * What a set of roles lets a principal see, normalized to an equivalence class
 * (ADR-0005 §6). Phase-1 minimal shape: all rows, or a set of store ids —
 * generalized only when a design partner's real scope model demands it.
 */
export type DataScope =
  { readonly kind: 'all' } | { readonly kind: 'stores'; readonly storeIds: readonly string[] };

/** One role's contribution to authorization, as read from the control plane. */
export interface RoleGrant {
  readonly dataScope: DataScope;
  readonly reports: readonly string[];
}

/** Server-resolved authorization context — the ONLY input to cache keys (原則B). */
export interface AuthzContext {
  readonly tenantId: TenantId;
  readonly allowedReports: readonly string[];
  readonly scope: DataScope;
  readonly scopeHash: string;
}

/** Claims carried by the vendor-signed embed JWT (ADR-0005 §7). */
export interface TokenClaims {
  readonly sub: string;
  readonly tenantId: TenantId;
  readonly sessionId: string;
  readonly epoch: number;
  readonly exp: number; // unix seconds
  readonly aud: string;
}

export type Denial = {
  readonly ok: false;
  readonly status: 401 | 403 | 404 | 500;
  readonly reason: string;
};
export type Decision = { readonly ok: true } | Denial;

export const deny = (status: Denial['status'], reason: string): Denial => ({
  ok: false,
  status,
  reason,
});
export const allow: Decision = { ok: true };
