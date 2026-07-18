// Test-side vendor simulation + gate wiring. Signing lives here (the vendor's
// backend signs in production — ADR-0005 §7); the module under test only
// verifies. Fixture mirrors spikes/vertical-slice (LOG-0031).
import { GateService } from '../../../src/modules/gate/application/gate-service.ts';
import type { AuthzEntry, ResultPayload } from '../../../src/modules/gate/application/ports.ts';
import {
  MemoryAuditSink,
  MemoryControlPlane,
  MemoryExecutor,
  MemoryKv,
} from '../../../src/modules/gate/infrastructure/memory.ts';
import {
  Es256TokenVerifier,
  WebCryptoHasher,
  type PublicJwk,
} from '../../../src/modules/gate/infrastructure/webcrypto.ts';
import type { Clock } from '../../../src/modules/gate/application/ports.ts';

const bytesToB64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const jsonB64url = (obj: unknown): string =>
  bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));

export class TestClock implements Clock {
  #now = 1_000_000;
  nowMs(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

export interface Vendor {
  readonly kid: string;
  readonly publicJwk: PublicJwk;
  sign(payload: Record<string, unknown>): Promise<string>;
}

export async function makeVendor(kid = 'k1'): Promise<Vendor> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as PublicJwk;
  return {
    kid,
    publicJwk,
    async sign(payload) {
      const input = `${jsonB64url({ alg: 'ES256', typ: 'JWT', kid })}.${jsonB64url(payload)}`;
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(input),
      );
      return `${input}.${bytesToB64url(new Uint8Array(sig))}`;
    },
  };
}

export function seedControlPlane(): MemoryControlPlane {
  const all = { kind: 'all' } as const;
  const s1 = { kind: 'stores', storeIds: ['s1'] } as const;
  return new MemoryControlPlane({
    tenants: { t_alpha: { authEpoch: 0 }, t_bravo: { authEpoch: 0 } },
    users: {
      alice: { tenantId: 't_alpha', authEpoch: 0, roles: ['manager'] },
      bob: { tenantId: 't_alpha', authEpoch: 0, roles: ['store1_staff'] },
      bev: { tenantId: 't_alpha', authEpoch: 0, roles: ['store1_viewer'] },
      boris: { tenantId: 't_bravo', authEpoch: 0, roles: ['manager'] },
    },
    roles: {
      t_alpha: {
        manager: { dataScope: all, reports: ['r_sales'] },
        store1_staff: { dataScope: s1, reports: ['r_sales'] },
        // Different role, same effective scope → must share cache (ADR-0005 §6)
        store1_viewer: { dataScope: s1, reports: ['r_sales'] },
      },
      t_bravo: { manager: { dataScope: all, reports: ['r_sales'] } },
    },
    reports: {
      t_alpha: { r_sales: { reportVersion: 1 } },
      t_bravo: { r_sales: { reportVersion: 1 } },
    },
    dataVersions: { t_alpha: 1, t_bravo: 1 },
  });
}

export const analyticsFixture = {
  t_alpha: [
    { store_id: 's1', category: 'A', amount: 40_000 },
    { store_id: 's1', category: 'B', amount: 25_000 },
    { store_id: 's2', category: 'A', amount: 52_900 },
    { store_id: 's2', category: 'C', amount: 30_000 },
    { store_id: 's2', category: 'D', amount: 10_000 },
  ],
  t_bravo: [
    { store_id: 's9', category: 'X', amount: 20_000 },
    { store_id: 's9', category: 'Y', amount: 12_000 },
    { store_id: 's9', category: 'Z', amount: 7_500 },
  ],
};

export async function makeHarness(overrides: { authzTtlMs?: number } = {}) {
  const clock = new TestClock();
  const vendor = await makeVendor();
  const controlPlane = seedControlPlane();
  const executor = new MemoryExecutor(analyticsFixture);
  const audit = new MemoryAuditSink();
  const authzCache = new MemoryKv<AuthzEntry>(clock);
  const resultCache = new MemoryKv<ResultPayload>(clock);
  const denylist = new MemoryKv<true>(clock);
  const shellCache = new MemoryKv<string>(clock);
  const gate = new GateService({
    verifier: new Es256TokenVerifier(new Map([[vendor.kid, vendor.publicJwk]]), 'gate'),
    controlPlane,
    authzCache,
    resultCache,
    denylist,
    shellCache,
    executor,
    hasher: new WebCryptoHasher(),
    audit,
    clock,
    ...(overrides.authzTtlMs !== undefined && { authzTtlMs: overrides.authzTtlMs }),
  });

  async function mint(userId: string, tamper: Record<string, unknown> = {}): Promise<string> {
    const user = controlPlane.users.get(userId);
    if (!user) throw new Error(`unknown fixture user ${userId}`);
    const tenant = controlPlane.tenants.get(user.tenantId);
    return vendor.sign({
      sub: userId,
      tenant_id: user.tenantId,
      sid: `sess_${userId}`,
      aud: 'gate',
      epoch: (tenant?.authEpoch ?? 0) + user.authEpoch,
      exp: Math.floor(clock.nowMs() / 1000) + 300,
      ...tamper,
    });
  }

  return { gate, clock, vendor, controlPlane, executor, audit, resultCache, denylist, mint };
}
