// Workers KV adapter over a fake binding — pins JSON round-trip and the 60s
// TTL floor (the ≤60s revocation-staleness bound of ADR-0006).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkersKvStore,
  type WorkersKvBinding,
} from '../../../src/modules/gate/infrastructure/workers-kv.ts';

class FakeKv implements WorkersKvBinding {
  readonly store = new Map<string, string>();
  readonly puts: { key: string; ttl: number | undefined }[] = [];
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, ttl: options?.expirationTtl });
  }
}

test('round-trips JSON values; missing key is undefined', async () => {
  const kv = new FakeKv();
  const store = new WorkersKvStore<{ tenantId: string; rows: number[] }>(kv);
  assert.equal(await store.get('missing'), undefined);
  await store.set('k', { tenantId: 't_alpha', rows: [1, 2] });
  assert.deepEqual(await store.get('k'), { tenantId: 't_alpha', rows: [1, 2] });
});

test('boolean denylist value survives the round-trip', async () => {
  const store = new WorkersKvStore<true>(new FakeKv());
  await store.set('deny', true);
  assert.equal(await store.get('deny'), true);
});

test('TTL below 60s is clamped up to the KV floor; no TTL persists', async () => {
  const kv = new FakeKv();
  const store = new WorkersKvStore<string>(kv);
  await store.set('a', 'x', 1_000); // 1s → floor
  await store.set('b', 'y', 120_000); // 120s → 120
  await store.set('c', 'z'); // no expiry
  assert.deepEqual(
    kv.puts.map((p) => p.ttl),
    [60, 120, undefined],
  );
});
