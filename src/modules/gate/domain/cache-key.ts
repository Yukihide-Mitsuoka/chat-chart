// Cache-key assembly (ADR-0005 §4/§5). Keys are pure functions of the
// server-resolved AuthzContext plus version tokens — never of client input
// (原則B). Hashing happens in the application layer (async platform API);
// this layer only assembles already-hashed parts.
import type { AuthzContext } from './types.ts';

export const KEY_SCHEMA = 'v1';

/** ② result-cache key. data_version inclusion makes stale entries unreachable. */
export function resultKey(
  ctx: AuthzContext,
  queryId: string,
  paramsHash: string,
  dataVersion: number,
): string {
  return `${KEY_SCHEMA}:${ctx.tenantId}:${ctx.scopeHash}:${queryId}:${paramsHash}:${dataVersion}`;
}

/** ① shell key — tenant-agnostic by design (原則A). */
export function shellKey(reportId: string, reportVersion: number): string {
  return `${reportId}:${reportVersion}`;
}

/** ③ authz-context key. */
export function authzKey(sessionId: string): string {
  return `${KEY_SCHEMA}:authz:${sessionId}`;
}

/** Denylist subject key for a revoked user. */
export function denyKey(userId: string): string {
  return `${KEY_SCHEMA}:deny:user:${userId}`;
}

/**
 * Canonical, order-insensitive serialization of query params — the paramsHash
 * input. Only own enumerable string/number/boolean entries participate.
 */
export function canonicalParams(
  params: Readonly<Record<string, string | number | boolean>>,
): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
}
