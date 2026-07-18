// HTTP handler over the in-memory-wired gate: routing, JWT extraction, and the
// generic-client-message mapping (denial reasons stay audit-side).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../../src/modules/gate/interface/handler.ts';
import { makeHarness } from './helpers.ts';

async function harnessHandler() {
  const h = await makeHarness();
  return { handler: createHandler(h.gate), mint: h.mint };
}
const get = (path: string, token?: string): Request =>
  new Request(`https://gate.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

test('GET /health needs no token', async () => {
  const { handler } = await harnessHandler();
  const res = await handler(get('/health'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('shell route returns HTML for an allowed report', async () => {
  const { handler, mint } = await harnessHandler();
  const res = await handler(get('/r/r_sales', await mint('alice')));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /shell report="r_sales"/);
});

test('data route returns JSON rows and a cache flag', async () => {
  const { handler, mint } = await harnessHandler();
  const token = await mint('alice');
  const first = await handler(get('/r/r_sales/data/q_sales_by_category', token));
  assert.equal(first.status, 200);
  const body = (await first.json()) as { cached: boolean; rows: unknown[] };
  assert.equal(body.cached, false);
  assert.ok(body.rows.length > 0);
  const second = await handler(get('/r/r_sales/data/q_sales_by_category', token));
  assert.equal(((await second.json()) as { cached: boolean }).cached, true);
});

test('missing token → 401 with a generic message (no reason leak)', async () => {
  const { handler } = await harnessHandler();
  const res = await handler(get('/r/r_sales'));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('forbidden report → 403 generic; the audit-side reason is not exposed', async () => {
  const { handler, mint } = await harnessHandler();
  const res = await handler(get('/r/r_secret', await mint('alice')));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
});

test('unknown paths and non-GET methods → 404', async () => {
  const { handler, mint } = await harnessHandler();
  assert.equal((await handler(get('/nope', await mint('alice')))).status, 404);
  const post = new Request('https://gate.example/r/r_sales', { method: 'POST' });
  assert.equal((await handler(post)).status, 404);
});
