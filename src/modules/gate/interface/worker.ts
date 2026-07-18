// Cloudflare Workers entry — the composition root (ADR-0006). Wires the real
// edge adapters (Workers KV + WebCrypto) to the runtime-agnostic GateService,
// then delegates routing to createHandler.
//
// SEAM: the control-plane reader and query executor are the *only* in-memory
// stand-ins here — their real adapters are separate future modules (Postgres
// control plane per 原則D; MCP gateway executor). A tiny fixture is seeded so
// `wrangler dev` serves real end-to-end responses today; replacing these two
// constructions with the Postgres/MCP adapters is the entire remaining wiring.
import { GateService } from '../application/gate-service.ts';
import type { AuthzEntry, ResultPayload } from '../application/ports.ts';
import { MemoryControlPlane, MemoryExecutor } from '../infrastructure/memory.ts';
import {
  Es256TokenVerifier,
  SystemClock,
  WebCryptoHasher,
  type PublicJwk,
} from '../infrastructure/webcrypto.ts';
import { WorkersKvStore, type WorkersKvBinding } from '../infrastructure/workers-kv.ts';
import { createHandler } from './handler.ts';

export interface GateEnv {
  readonly RESULT_KV: WorkersKvBinding;
  readonly AUTHZ_KV: WorkersKvBinding;
  readonly DENYLIST_KV: WorkersKvBinding;
  readonly SHELL_KV: WorkersKvBinding;
  /** JSON object `{ "<kid>": <public-JWK> }` — vendor JWT verification keys. */
  readonly VENDOR_KEYS: string;
  /** Expected JWT `aud`. */
  readonly GATE_AUDIENCE: string;
}

// SEAM (control plane = Postgres): a one-tenant fixture for local `wrangler dev`.
function bootstrapControlPlane(): MemoryControlPlane {
  return new MemoryControlPlane({
    tenants: { t_demo: { authEpoch: 0 } },
    users: { u_demo: { tenantId: 't_demo', authEpoch: 0, roles: ['manager'] } },
    roles: { t_demo: { manager: { dataScope: { kind: 'all' }, reports: ['r_demo'] } } },
    reports: { t_demo: { r_demo: { reportVersion: 1 } } },
    dataVersions: { t_demo: 1 },
  });
}

// SEAM (executor = MCP gateway): per-tenant dataset stand-in.
function bootstrapExecutor(): MemoryExecutor {
  return new MemoryExecutor({
    t_demo: [
      { store_id: 's1', category: 'A', amount: 40_000 },
      { store_id: 's1', category: 'B', amount: 25_000 },
    ],
  });
}

function noopAudit() {
  return {
    async record(): Promise<void> {
      // SEAM: audit sink → Postgres audit_logs. No-op until the control-plane
      // module lands; deliberately never throws so a request is not failed by
      // an audit write.
    },
  };
}

export function buildGate(env: GateEnv): GateService {
  const clock = new SystemClock();
  const vendorKeys = new Map<string, PublicJwk>(
    Object.entries(JSON.parse(env.VENDOR_KEYS) as Record<string, PublicJwk>),
  );
  return new GateService({
    verifier: new Es256TokenVerifier(vendorKeys, env.GATE_AUDIENCE),
    controlPlane: bootstrapControlPlane(),
    authzCache: new WorkersKvStore<AuthzEntry>(env.AUTHZ_KV),
    resultCache: new WorkersKvStore<ResultPayload>(env.RESULT_KV),
    denylist: new WorkersKvStore<true>(env.DENYLIST_KV),
    shellCache: new WorkersKvStore<string>(env.SHELL_KV),
    executor: bootstrapExecutor(),
    hasher: new WebCryptoHasher(),
    audit: noopAudit(),
    clock,
  });
}

export default {
  async fetch(request: Request, env: GateEnv): Promise<Response> {
    return createHandler(buildGate(env))(request);
  },
};
