// Role → data-scope normalization (ADR-0005 §6): roles collapse into the
// equivalence class of "what rows they see", so roles with identical effective
// scope share cache entries while differing scopes can never collide.
import type { DataScope, RoleGrant } from './types.ts';

/** Union of the grants' scopes. Any all-rows grant absorbs the rest. */
export function normalizeScope(grants: readonly RoleGrant[]): DataScope {
  if (grants.length === 0 || grants.some((g) => g.dataScope.kind === 'all')) {
    // No grants → treated as 'all' would be privilege escalation; callers must
    // deny principals without grants before scoping. Enforced in decisions.ts.
    return { kind: 'all' };
  }
  const storeIds = new Set<string>();
  for (const g of grants) {
    if (g.dataScope.kind === 'stores') for (const id of g.dataScope.storeIds) storeIds.add(id);
  }
  return { kind: 'stores', storeIds: [...storeIds].sort() };
}

/**
 * Canonical string form — the hash input. Deterministic: same effective scope
 * always serializes identically (sorted, deduplicated).
 */
export function canonicalScope(scope: DataScope): string {
  return scope.kind === 'all' ? 'all' : `stores:${scope.storeIds.join(',')}`;
}

/** Reports visible through any grant, deduplicated and sorted. */
export function allowedReports(grants: readonly RoleGrant[]): readonly string[] {
  return [...new Set(grants.flatMap((g) => g.reports))].sort();
}
