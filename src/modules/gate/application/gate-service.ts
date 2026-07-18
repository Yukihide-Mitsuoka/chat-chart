// The gate's two use cases (ADR-0005 §7): serve a shell, serve data.
// Runtime-agnostic by ADR-0006 rule 1 — all platform specifics live behind
// ports. The vertical-slice spike's 12 tests are the acceptance contract.
import { authzKey, canonicalParams, denyKey, resultKey, shellKey } from '../domain/cache-key.ts';
import {
  checkEpoch,
  checkHasGrants,
  checkPayloadTenant,
  checkPrincipal,
  checkReportAllowed,
  isDenial,
} from '../domain/decisions.ts';
import { allowedReports, canonicalScope, normalizeScope } from '../domain/scope.ts';
import type { AuthzContext, Denial } from '../domain/types.ts';
import { deny } from '../domain/types.ts';
import type {
  AuditSink,
  AuthzEntry,
  Clock,
  ControlPlaneReader,
  Hasher,
  KeyValueStore,
  QueryExecutor,
  ResultPayload,
  TokenVerifier,
} from './ports.ts';

export interface GateDeps {
  readonly verifier: TokenVerifier;
  readonly controlPlane: ControlPlaneReader;
  readonly authzCache: KeyValueStore<AuthzEntry>;
  readonly resultCache: KeyValueStore<ResultPayload>;
  readonly denylist: KeyValueStore<true>;
  readonly shellCache: KeyValueStore<string>;
  readonly executor: QueryExecutor;
  readonly hasher: Hasher;
  readonly audit: AuditSink;
  readonly clock: Clock;
  /** ③ TTL — bounds revocation staleness together with denylist propagation. */
  readonly authzTtlMs?: number;
}

export type ShellResponse =
  Denial | { readonly ok: true; readonly shellKey: string; readonly html: string };
export type DataResponse =
  Denial | { readonly ok: true; readonly cached: boolean; readonly rows: readonly unknown[] };

interface DataRequest {
  readonly reportId: string;
  readonly queryId: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /** Deliberately accepted and ignored — 原則B. Tests forge it. */
  readonly clientTenantId?: string;
}

export class GateService {
  readonly #d: GateDeps;
  readonly #authzTtlMs: number;
  readonly #inflight = new Map<string, Promise<Awaited<ReturnType<QueryExecutor['execute']>>>>();

  constructor(deps: GateDeps) {
    this.#d = deps;
    this.#authzTtlMs = deps.authzTtlMs ?? 60_000;
  }

  async #authenticate(
    token: string,
  ): Promise<Denial | { readonly ok: true; readonly ctx: AuthzContext }> {
    const d = this.#d;
    const now = d.clock.nowMs();
    const verified = await d.verifier.verify(token, now);
    if (!verified.ok) return deny(401, verified.reason);
    const { claims } = verified;

    if (await d.denylist.get(denyKey(claims.sub))) return deny(401, 'denylisted');

    // Epoch + principal checks always read the SoR — revocation must not be
    // masked by a cached context (ADR-0005 §3③; the ctx body may be cached,
    // the liveness checks may not).
    const tenantEpoch = await d.controlPlane.getTenantEpoch(claims.tenantId);
    const user = await d.controlPlane.getUser(claims.tenantId, claims.sub);
    if (tenantEpoch === null || user === null) return deny(401, 'unknown-principal');
    const principal = checkPrincipal(claims, user, true);
    if (isDenial(principal)) return principal;
    const epoch = checkEpoch(claims, tenantEpoch, user.authEpoch);
    if (isDenial(epoch)) return epoch;

    const cached = await d.authzCache.get(authzKey(claims.sessionId));
    if (cached) return { ok: true, ctx: cached.ctx };

    const grants = user.grants;
    const hasGrants = checkHasGrants(grants.length);
    if (isDenial(hasGrants)) return hasGrants;
    const scope = normalizeScope(grants);
    const ctx: AuthzContext = {
      tenantId: claims.tenantId,
      allowedReports: allowedReports(grants),
      scope,
      scopeHash: await d.hasher.sha256hex(canonicalScope(scope)),
    };
    await d.authzCache.set(authzKey(claims.sessionId), { ctx }, this.#authzTtlMs);
    return { ok: true, ctx };
  }

  async requestShell(token: string, reportId: string): Promise<ShellResponse> {
    const d = this.#d;
    const auth = await this.#authenticate(token);
    if (isDenial(auth)) return auth;
    const { ctx } = auth;
    const allowed = checkReportAllowed(ctx, reportId);
    if (isDenial(allowed)) return allowed;

    const version = await d.controlPlane.getReportVersion(ctx.tenantId, reportId);
    if (version === null) return deny(404, 'unknown-report');
    const key = shellKey(reportId, version);
    const hit = await d.shellCache.get(key);
    if (hit !== undefined) return { ok: true, shellKey: key, html: hit };
    const html = `<shell report="${reportId}" v="${version}"/>`;
    await d.shellCache.set(key, html);
    return { ok: true, shellKey: key, html };
  }

  async requestData(token: string, req: DataRequest): Promise<DataResponse> {
    const d = this.#d;
    const auth = await this.#authenticate(token);
    if (isDenial(auth)) return auth;
    const { ctx } = auth;
    const allowed = checkReportAllowed(ctx, req.reportId);
    if (isDenial(allowed)) return allowed;

    const params = req.params ?? {};
    const paramsHash = await d.hasher.sha256hex(canonicalParams(params));
    const dataVersion = await d.controlPlane.getDataVersion(ctx.tenantId);
    const key = resultKey(ctx, req.queryId, paramsHash, dataVersion);

    const hit = await d.resultCache.get(key);
    if (hit) {
      const self = checkPayloadTenant(hit.tenantId, ctx);
      if (isDenial(self)) return self;
      return { ok: true, cached: true, rows: hit.rows };
    }

    // Single-flight: concurrent misses on one key execute once (ADR-0005 §8).
    let flight = this.#inflight.get(key);
    if (!flight) {
      flight = d.executor
        .execute(ctx, req.queryId, params)
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, flight);
    }
    const result = await flight;
    if (!result.ok) return deny(result.status, result.reason); // errors are never cached
    await d.resultCache.set(key, { tenantId: ctx.tenantId, rows: result.rows });
    await d.audit.record({
      tenantId: ctx.tenantId,
      action: 'query.execute',
      detail: { queryId: req.queryId },
    });
    return { ok: true, cached: false, rows: result.rows };
  }
}
