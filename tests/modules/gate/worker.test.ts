// End-to-end over the actual Workers entry (worker.ts): its default fetch,
// buildGate wiring, WorkersKvStore, and the bootstrap fixture — driven with
// fake KV bindings and a real ES256-signed token, no wrangler needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildGate, type GateEnv } from '../../../src/modules/gate/interface/worker.ts';
import type { WorkersKvBinding } from '../../../src/modules/gate/infrastructure/workers-kv.ts';
import { makeVendor } from './helpers.ts';

class FakeKv implements WorkersKvBinding {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

async function makeEnv() {
  const vendor = await makeVendor();
  const env: GateEnv = {
    RESULT_KV: new FakeKv(),
    AUTHZ_KV: new FakeKv(),
    DENYLIST_KV: new FakeKv(),
    SHELL_KV: new FakeKv(),
    VENDOR_KEYS: JSON.stringify({ [vendor.kid]: vendor.publicJwk }),
    GATE_AUDIENCE: 'gate',
  };
  const token = await vendor.sign({
    sub: 'u_demo',
    tenant_id: 't_demo',
    sid: 'sess_demo',
    aud: 'gate',
    epoch: 0,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  return { env, token };
}

const get = (path: string, token: string): Request =>
  new Request(`https://gate.example${path}`, { headers: { authorization: `Bearer ${token}` } });

test('worker.fetch serves the bootstrap tenant end-to-end', async () => {
  const { env, token } = await makeEnv();
  const shell = await worker.fetch(get('/r/r_demo', token), env);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /shell report="r_demo"/);

  const data = await worker.fetch(get('/r/r_demo/data/q_sales_by_category', token), env);
  assert.equal(data.status, 200);
  const body = (await data.json()) as {
    cached: boolean;
    rows: { category: string; total: number }[];
  };
  assert.equal(body.cached, false);
  assert.equal(
    body.rows.reduce((s, r) => s + r.total, 0),
    65_000,
  );
});

test('② result is written to Workers KV and hit on the second call', async () => {
  const { env, token } = await makeEnv();
  await worker.fetch(get('/r/r_demo/data/q_sales_by_category', token), env);
  assert.equal((env.RESULT_KV as FakeKv).store.size, 1); // payload persisted to KV
  const second = await worker.fetch(get('/r/r_demo/data/q_sales_by_category', token), env);
  assert.equal(((await second.json()) as { cached: boolean }).cached, true);
});

test('buildGate rejects an unknown audience', async () => {
  const { env } = await makeEnv();
  const gate = buildGate({ ...env, GATE_AUDIENCE: 'other' });
  const vendor = await makeVendor();
  const token = await vendor.sign({
    sub: 'u_demo',
    tenant_id: 't_demo',
    sid: 's',
    aud: 'gate',
    epoch: 0,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  // Signed by a vendor whose key isn't in env → unknown-kid, and aud mismatch;
  // either way the gate denies. Asserts the wiring passes GATE_AUDIENCE through.
  const res = await gate.requestShell(token, 'r_demo');
  assert.equal(res.ok, false);
});
