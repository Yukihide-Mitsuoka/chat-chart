// Acceptance suite — the vertical-slice spike's 12 proofs (LOG-0031) ported
// onto the real module, per ADR-0006 rule 2. Runs on Node only (in-memory +
// WebCrypto adapters); the Workers adapter must pass the same suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { denyKey, resultKey } from '../../../src/modules/gate/domain/cache-key.ts';
import { canonicalScope } from '../../../src/modules/gate/domain/scope.ts';
import { WebCryptoHasher } from '../../../src/modules/gate/infrastructure/webcrypto.ts';
import { makeHarness } from './helpers.ts';

const REQ = { reportId: 'r_sales', queryId: 'q_sales_by_category' };
const total = (rows: readonly unknown[]): number =>
  rows.reduce((sum: number, r) => sum + (r as { total: number }).total, 0);

test('happy path: miss then hit, identical rows', async () => {
  const h = await makeHarness();
  const token = await h.mint('alice');
  const first = await h.gate.requestData(token, REQ);
  assert.ok(first.ok);
  assert.equal(first.cached, false);
  assert.equal(total(first.rows), 157_900);
  const second = await h.gate.requestData(token, REQ);
  assert.ok(second.ok);
  assert.equal(second.cached, true);
  assert.deepEqual(second.rows, first.rows);
  assert.equal(h.executor.executorCalls, 1);
});

test('原則B: forged client tenant_id has zero effect on the key or the data', async () => {
  const h = await makeHarness();
  await h.gate.requestData(await h.mint('alice'), REQ); // warm t_alpha's entry
  const res = await h.gate.requestData(await h.mint('boris'), {
    ...REQ,
    clientTenantId: 't_alpha', // attack: bravo user addresses alpha's cache
  });
  assert.ok(res.ok);
  assert.equal(res.cached, false); // key came from ctx → different namespace
  assert.equal(total(res.rows), 39_500); // bravo's own data only
  for (const k of h.resultCache.keys()) assert.match(k, /^v1:t_(alpha|bravo):/);
});

test('JWT tenant claim must match the SoR: bravo user claiming t_alpha is rejected', async () => {
  const h = await makeHarness();
  const forged = await h.mint('boris', { tenant_id: 't_alpha' });
  const res = await h.gate.requestData(forged, REQ);
  assert.ok(!res.ok);
  assert.equal(res.status, 401);
  assert.equal(res.reason, 'unknown-principal');
});

test('bad signature / expiry / audience are rejected', async () => {
  const h = await makeHarness();
  const token = await h.mint('alice');
  const [hd, pl] = token.split('.') as [string, string, string];
  const badSig = await h.gate.requestData(`${hd}.${pl}.${'A'.repeat(86)}`, REQ);
  assert.ok(!badSig.ok && badSig.status === 401);
  const expired = await h.gate.requestData(await h.mint('alice', { exp: 1 }), REQ);
  assert.ok(!expired.ok && expired.reason === 'expired');
  const badAud = await h.gate.requestData(await h.mint('alice', { aud: 'other' }), REQ);
  assert.ok(!badAud.ok && badAud.reason === 'bad-aud');
});

test('ADR-0005 §6: different scope → different key; same effective scope → shared cache', async () => {
  const h = await makeHarness();
  const manager = await h.gate.requestData(await h.mint('alice'), REQ);
  const store1 = await h.gate.requestData(await h.mint('bob'), REQ);
  assert.ok(manager.ok && store1.ok);
  assert.equal(total(manager.rows), 157_900);
  assert.equal(total(store1.rows), 65_000); // s1 only
  assert.equal(h.executor.executorCalls, 2); // scopes differ → no sharing
  // bev holds a *different role* with the same effective scope as bob
  const viewer = await h.gate.requestData(await h.mint('bev'), REQ);
  assert.ok(viewer.ok);
  assert.equal(viewer.cached, true); // role explosion contained
  assert.deepEqual(viewer.rows, store1.rows);
  assert.equal(h.executor.executorCalls, 2);
});

test('原則C-4: a poisoned entry under the requester-derived key is caught, nothing served', async () => {
  const h = await makeHarness();
  // Simulate the worst key-derivation bug: bravo's own key holds alpha's payload.
  const hasher = new WebCryptoHasher();
  const bravoKey = resultKey(
    {
      tenantId: 't_bravo',
      allowedReports: ['r_sales'],
      scope: { kind: 'all' },
      scopeHash: await hasher.sha256hex(canonicalScope({ kind: 'all' })),
    },
    REQ.queryId,
    await hasher.sha256hex(''),
    1,
  );
  await h.resultCache.set(bravoKey, { tenantId: 't_alpha', rows: [{ category: 'A', total: 1 }] });
  const res = await h.gate.requestData(await h.mint('boris'), REQ);
  assert.ok(!res.ok);
  assert.equal(res.status, 500);
  assert.equal(res.reason, 'payload-tenant-mismatch');
  assert.ok(!('rows' in res)); // nothing leaks alongside the error
});

test('ADR-0005 §5: data_version bump invalidates without purging', async () => {
  const h = await makeHarness();
  const token = await h.mint('alice');
  await h.gate.requestData(token, REQ);
  h.controlPlane.bumpDataVersion('t_alpha');
  const res = await h.gate.requestData(token, REQ);
  assert.ok(res.ok);
  assert.equal(res.cached, false); // new key → automatic miss
  assert.equal(h.executor.executorCalls, 2);
  assert.equal(h.resultCache.size, 2); // old entry left to age out, never served
});

test('ADR-0005 §5: report edit bumps the shell key', async () => {
  const h = await makeHarness();
  const token = await h.mint('alice');
  const v1 = await h.gate.requestShell(token, 'r_sales');
  assert.ok(v1.ok && v1.shellKey === 'r_sales:1');
  h.controlPlane.bumpReportVersion('t_alpha', 'r_sales');
  const v2 = await h.gate.requestShell(token, 'r_sales');
  assert.ok(v2.ok && v2.shellKey === 'r_sales:2');
});

test('revocation: denylist + epoch cut off an unexpired JWT immediately', async () => {
  const h = await makeHarness();
  const token = await h.mint('bob'); // valid for 5 minutes
  const before = await h.gate.requestData(token, REQ);
  assert.ok(before.ok);
  // Revoke: epoch bump at the SoR + denylist entry (revocation_events → KV).
  h.controlPlane.revokeUser('bob');
  await h.denylist.set(denyKey('bob'), true, 300_000);
  const denied = await h.gate.requestData(token, REQ);
  assert.ok(!denied.ok && denied.reason === 'denylisted');
  // Even once the denylist entry lapses, the epoch mismatch still rejects.
  h.denylist.delete(denyKey('bob'));
  const stale = await h.gate.requestData(token, REQ);
  assert.ok(!stale.ok && stale.reason === 'stale-epoch');
  // A token minted *after* revocation carries the new epoch and works again.
  const fresh = await h.gate.requestData(await h.mint('bob'), REQ);
  assert.ok(fresh.ok);
});

test('single-flight: concurrent misses on one key execute once', async () => {
  const h = await makeHarness();
  const token = await h.mint('alice');
  const results = await Promise.all(
    Array.from({ length: 10 }, () => h.gate.requestData(token, REQ)),
  );
  assert.ok(results.every((r) => r.ok));
  assert.equal(h.executor.executorCalls, 1);
});

test('errors are never cached', async () => {
  const h = await makeHarness();
  const res = await h.gate.requestData(await h.mint('alice'), {
    reportId: 'r_sales',
    queryId: 'q_nope',
  });
  assert.ok(!res.ok);
  assert.equal(res.status, 404);
  assert.equal(h.resultCache.size, 0);
});

test('403 outside allowed_reports; zero grants deny instead of widening', async () => {
  const h = await makeHarness();
  const secret = await h.gate.requestData(await h.mint('alice'), {
    reportId: 'r_secret',
    queryId: 'q_sales_by_category',
  });
  assert.ok(!secret.ok && secret.status === 403);
  h.controlPlane.users.set('greg', { tenantId: 't_alpha', authEpoch: 0, roles: [] });
  const grantless = await h.gate.requestData(await h.mint('greg'), REQ);
  assert.ok(!grantless.ok && grantless.status === 403 && grantless.reason === 'no-grants');
});

test('③ ctx cache expires by TTL and is rebuilt from the SoR', async () => {
  const h = await makeHarness({ authzTtlMs: 60_000 });
  const token = await h.mint('alice');
  await h.gate.requestData(token, REQ);
  h.clock.advance(61_000);
  const res = await h.gate.requestData(token, REQ);
  assert.ok(res.ok); // rebuilt ctx, same scope → still a ② hit
  assert.equal(res.cached, true);
});
