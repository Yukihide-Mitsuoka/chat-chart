// The gate's HTTP executor client. Beyond the request it sends, the test that
// carries the most weight is the round trip: this client wired straight to the
// real executor handler, so the wire contract is verified from both ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpQueryExecutor,
  type FetchLike,
} from '../../../src/modules/gate/infrastructure/http-executor.ts';
import { createExecutorHandler } from '../../../src/modules/executor/interface/http.ts';
import { ExecuteQuery } from '../../../src/modules/executor/application/execute.ts';
import {
  MemoryAuditSink,
  MemoryBindingResolver,
  RecordingQueryRunner,
} from '../../../src/modules/executor/infrastructure/memory.ts';
import type { AuthzContext } from '../../../src/modules/gate/domain/types.ts';

const TOKEN = 'service-secret';
const ctx = (over: Partial<AuthzContext> = {}): AuthzContext => ({
  tenantId: 't_alpha',
  allowedReports: ['r_sales'],
  scope: { kind: 'all' },
  scopeHash: 'h',
  ...over,
});

function fakeFetch(status: number, body: unknown, raw?: string) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return raw ?? JSON.stringify(body);
      },
    };
  };
  return { fetchImpl, calls };
}

const client = (fetchImpl: FetchLike) =>
  new HttpQueryExecutor({ baseUrl: 'https://executor.internal', serviceToken: TOKEN, fetchImpl });

test('sends tenantId, queryId, params and the gate scope — but never a dataset', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { rows: [] });
  await client(fetchImpl).execute(ctx({ scope: { kind: 'stores', storeIds: ['s1'] } }), 'q_sales', {
    since: '2026-01-01',
  });
  const sent = calls[0];
  assert.equal(sent?.url, 'https://executor.internal/v1/query');
  assert.equal(sent?.headers['authorization'], `Bearer ${TOKEN}`);
  assert.deepEqual(sent?.body, {
    tenantId: 't_alpha',
    queryId: 'q_sales',
    params: { since: '2026-01-01' },
    scope: { kind: 'stores', storeIds: ['s1'] },
  });
  assert.ok(!('dataset' in (sent?.body ?? {}))); // ① boundary stays the executor's
});

test('a trailing slash in the base URL does not double up', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { rows: [] });
  await new HttpQueryExecutor({
    baseUrl: 'https://executor.internal/',
    serviceToken: TOKEN,
    fetchImpl,
  }).execute(ctx(), 'q_sales', {});
  assert.equal(calls[0]?.url, 'https://executor.internal/v1/query');
});

test('rows come back on 200', async () => {
  const { fetchImpl } = fakeFetch(200, { rows: [{ category: 'A' }] });
  const r = await client(fetchImpl).execute(ctx(), 'q_sales', {});
  assert.ok(r.ok);
  assert.deepEqual(r.rows, [{ category: 'A' }]);
});

test('404 maps to 404; other statuses map to 500', async () => {
  const notFound = await client(fakeFetch(404, { error: 'unknown query' }).fetchImpl).execute(
    ctx(),
    'q_sales',
    {},
  );
  assert.equal(notFound.ok === false && notFound.status, 404);
  const failed = await client(fakeFetch(500, { error: 'execution-failed' }).fetchImpl).execute(
    ctx(),
    'q_sales',
    {},
  );
  assert.equal(failed.ok === false && failed.status, 500);
});

test('a rejected service token surfaces as 500, not as a client error', async () => {
  // 401 means OUR token is wrong — an operator problem the end user cannot act on.
  const { fetchImpl } = fakeFetch(401, { error: 'unauthorized' });
  const r = await client(fetchImpl).execute(ctx(), 'q_sales', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 500);
});

test('an unreachable service is 500 with an opaque reason', async () => {
  const boom: FetchLike = async () => {
    throw new Error('getaddrinfo ENOTFOUND executor.internal');
  };
  const r = await client(boom).execute(ctx(), 'q_sales', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'executor-unreachable'); // no hostname leak
});

test('a malformed success body is an error, not silently empty rows', async () => {
  const missing = await client(fakeFetch(200, { notRows: 1 }).fetchImpl).execute(ctx(), 'q', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, 'executor-bad-response');
  const garbage = await client(fakeFetch(200, null, '<html>502</html>').fetchImpl).execute(
    ctx(),
    'q',
    {},
  );
  assert.equal(garbage.ok, false);
  assert.equal(garbage.ok === false && garbage.reason, 'executor-bad-response');
});

test('round trip: the client against the real handler enforces the tenant boundary', async () => {
  const runner = new RecordingQueryRunner();
  const handler = createExecutorHandler({
    execute: new ExecuteQuery({
      bindings: new MemoryBindingResolver(
        {
          t_alpha: { tenantId: 't_alpha', dataset: 't_alpha' },
          t_bravo: { tenantId: 't_bravo', dataset: 't_bravo' },
        },
        { tables: [{ name: 'orders', scopeColumn: 'store_id' }] },
      ),
      runner,
      audit: new MemoryAuditSink(),
    }),
    catalog: {
      async sqlFor() {
        return 'SELECT category FROM orders';
      },
    },
    serviceToken: TOKEN,
  });
  // Wire the client's fetch straight into the handler — no network, real contract.
  const wired: FetchLike = async (url, init) => {
    const res = await handler(
      new Request(url, { method: init.method, headers: init.headers, body: init.body }),
    );
    return { ok: res.ok, status: res.status, text: () => res.text() };
  };
  const executor = new HttpQueryExecutor({
    baseUrl: 'https://executor.internal',
    serviceToken: TOKEN,
    fetchImpl: wired,
  });

  runner.willReturn([{ category: 'A' }]);
  const alpha = await executor.execute(ctx(), 'q_sales', {});
  assert.ok(alpha.ok);
  assert.match(runner.lastSql ?? '', /t_alpha\.orders/);

  await executor.execute(ctx({ tenantId: 't_bravo' }), 'q_sales', {});
  assert.match(runner.lastSql ?? '', /t_bravo\.orders/);
  assert.doesNotMatch(runner.lastSql ?? '', /t_alpha/);

  // A wrong token over the same wire is refused end to end.
  const impostor = new HttpQueryExecutor({
    baseUrl: 'https://executor.internal',
    serviceToken: 'wrong',
    fetchImpl: wired,
  });
  const before = runner.calls.length;
  const denied = await impostor.execute(ctx(), 'q_sales', {});
  assert.equal(denied.ok, false);
  assert.equal(runner.calls.length, before); // nothing executed
});
