// Pure authorization decisions (ADR-0005 §2/§8). Each returns a Decision so
// the application layer can fail fast with the exact denial reason (COD-011);
// reasons are audit-facing, never leaked to clients verbatim.
import type { AuthzContext, Denial, TokenClaims } from './types.ts';
import { allow, deny, type Decision } from './types.ts';

/** The claimed tenant must be the tenant the user actually belongs to (SoR wins). */
export function checkPrincipal(
  claims: TokenClaims,
  user: { readonly tenantId: string } | null,
  tenantExists: boolean,
): Decision {
  if (!tenantExists || user === null) return deny(401, 'unknown-principal');
  if (user.tenantId !== claims.tenantId) return deny(401, 'unknown-principal');
  return allow;
}

/** Epoch snapshot in the token must match the SoR's current epochs (revocation). */
export function checkEpoch(claims: TokenClaims, tenantEpoch: number, userEpoch: number): Decision {
  return claims.epoch === tenantEpoch + userEpoch ? allow : deny(401, 'stale-epoch');
}

/** A principal with no grants gets nothing — never an implicit 'all' scope. */
export function checkHasGrants(grantCount: number): Decision {
  return grantCount > 0 ? allow : deny(403, 'no-grants');
}

export function checkReportAllowed(ctx: AuthzContext, reportId: string): Decision {
  return ctx.allowedReports.includes(reportId) ? allow : deny(403, 'report-not-allowed');
}

/**
 * Belt-and-suspenders payload self-check (原則C-4): a cached payload minted for
 * another tenant must never leave the gate, even under a key-derivation bug.
 */
export function checkPayloadTenant(payloadTenantId: string, ctx: AuthzContext): Decision {
  return payloadTenantId === ctx.tenantId ? allow : deny(500, 'payload-tenant-mismatch');
}

export const isDenial = (d: Decision): d is Denial => !d.ok;
