// Pure row → domain mappers. Separated from the SQL so the shaping is
// unit-testable without a database; the queries themselves are proven live
// against Neon (spikes/control-plane-neon).
import type { DataScope, RoleGrant } from '../../gate/domain/types.ts';

/**
 * roles.data_scope (JSONB) → DataScope. `{}` (a role with no row restriction)
 * and any unrecognized shape map to `all`; `{"store_ids":[...]}` maps to the
 * store scope. Store ids are sorted so equal scopes hash equally downstream.
 */
export function parseDataScope(raw: unknown): DataScope {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const ids = (raw as Record<string, unknown>)['store_ids'];
    if (Array.isArray(ids) && ids.every((v) => typeof v === 'string')) {
      return { kind: 'stores', storeIds: [...(ids as string[])].sort() };
    }
  }
  return { kind: 'all' };
}

/** One row per role the user holds: its scope JSONB and the report slugs it allows. */
export interface RoleRow {
  readonly data_scope: unknown;
  readonly reports: readonly (string | null)[];
}

/** Rows → RoleGrant[]. Null report slugs (from the left join) are dropped. */
export function rowsToGrants(rows: readonly RoleRow[]): RoleGrant[] {
  return rows.map((r) => ({
    dataScope: parseDataScope(r.data_scope),
    reports: r.reports.filter((s): s is string => s !== null),
  }));
}
