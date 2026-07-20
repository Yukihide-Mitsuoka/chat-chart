// The executor's HTTP interface. Because the caller now asserts tenantId and
// scope over the wire, the assertions that matter most are about refusing an
// unauthenticated or malformed request before any query is bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutorHandler } from '../../../src/modules/executor/interface/http.ts';
import { ExecuteQuery } from '../../../src/modules/executor/application/execute.ts';
import {
  MemoryAuditSink,
  MemoryBindingResolver,
  RecordingQueryRunner,
} from '../../../src/modules/executor/infrastructure/memory.ts';

const TOKEN = 'service-secret';
const POLICY = { tables: [{ name: 'orders', scopeColumn: 'store_id' }] };
const SQL = 'SELECT category, SUM(amount) AS total FROM orders GROUP BY category';

function harness() {
  const runner = new RecordingQueryRunner();
  const audit = new MemoryAuditSink();
  const handler = createExecutorHandler({
    execute: new ExecuteQuery({
      bindings: new MemoryBindingResolver(
        {
          t_alpha: { tenantId: 't_alpha', dataset: 't_alpha' },
          t_bravo: { tenantId: 't_bravo', dataset: 't_bravo' },
        },
        POLICY,
      ),
      runner,
      audit,
    }),
    catalog: {
      async sqlFor(_t, queryId) {
        return queryId === 'q_sales' ? SQL : null;
      },
    },
    serviceToken: TOKEN,
  });
  return { handler, runner, audit };
}

const post = (body: unknown, token: string | null = TOKEN): Request =>
  new Request('https://executor.internal/v1/query', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const VALID = { tenantId: 't_alpha', queryId: 'q_sales', scope: { kind: 'all' } };

test('an authenticated request runs and returns rows', async () => {
  const { handler, runner } = harness();
  runner.willReturn([{ category: 'A', total: 1 }]);
  const res = await handler(post(VALID));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { rows: [{ category: 'A', total: 1 }] });
  assert.match(runner.lastSql ?? '', /t_alpha\.orders/);
});

test('the wire scope reaches the SQL filter', async () => {
  const { handler, runner } = harness();
  await handler(post({ ...VALID, scope: { kind: 'stores', storeIds: ['s1'] } }));
  assert.match(runner.lastSql ?? '', /store_id IN \('s1'\)/);
});

// --- the trust boundary ---------------------------------------------------

test('a missing token is refused before anything is bound', async () => {
  const { handler, runner } = harness();
  const res = await handler(post(VALID, null));
  assert.equal(res.status, 401);
  assert.equal(runner.calls.length, 0);
});

test('a wrong token is refused', async () => {
  const { handler, runner } = harness();
  const res = await handler(post(VALID, 'not-the-secret'));
  assert.equal(res.status, 401);
  assert.equal(runner.calls.length, 0);
});

test('a token that is a prefix of the secret is refused', async () => {
  const { handler } = harness();
  const res = await handler(post(VALID, TOKEN.slice(0, -1)));
  assert.equal(res.status, 401);
});

test('the response never echoes the service token', async () => {
  const { handler } = harness();
  const body = await (await handler(post(VALID, 'wrong'))).text();
  assert.doesNotMatch(body, new RegExp(TOKEN));
});

// --- input validation: unknown shapes are refused, never coerced open ------

test('an unparsable body is 400, not a crash', async () => {
  const { handler, runner } = harness();
  const res = await handler(post('{not json', TOKEN));
  assert.equal(res.status, 400);
  assert.equal(runner.calls.length, 0);
});

test('a missing or malformed scope is 400 — it never defaults to all rows', async () => {
  const { handler, runner } = harness();
  for (const scope of [undefined, null, {}, { kind: 'everything' }, { kind: 'stores' }]) {
    const res = await handler(post({ ...VALID, scope }));
    assert.equal(res.status, 400, JSON.stringify(scope));
  }
  assert.equal(runner.calls.length, 0);
});

test('a non-scalar param value is 400', async () => {
  const { handler } = harness();
  const res = await handler(post({ ...VALID, params: { bad: { nested: true } } }));
  assert.equal(res.status, 400);
});

test('a missing tenantId or queryId is 400', async () => {
  const { handler } = harness();
  assert.equal((await handler(post({ queryId: 'q_sales', scope: { kind: 'all' } }))).status, 400);
  assert.equal((await handler(post({ tenantId: 't_alpha', scope: { kind: 'all' } }))).status, 400);
});

// --- routing and failure mapping ------------------------------------------

test('an unknown query id is 404', async () => {
  const { handler } = harness();
  assert.equal((await handler(post({ ...VALID, queryId: 'q_missing' }))).status, 404);
});

test('an unknown tenant is 404', async () => {
  const { handler } = harness();
  assert.equal((await handler(post({ ...VALID, tenantId: 't_ghost' }))).status, 404);
});

test('a policy refusal is 500, not a client error', async () => {
  const bad = createExecutorHandler({
    execute: new ExecuteQuery({
      bindings: new MemoryBindingResolver(
        { t_alpha: { tenantId: 't_alpha', dataset: 't_alpha' } },
        POLICY,
      ),
      runner: new RecordingQueryRunner(),
      audit: new MemoryAuditSink(),
    }),
    catalog: {
      async sqlFor() {
        return 'SELECT * FROM t_bravo.orders';
      },
    },
    serviceToken: TOKEN,
  });
  assert.equal((await bad(post(VALID))).status, 500);
});

test('health needs no token; unknown paths are 404', async () => {
  const { handler } = harness();
  assert.equal((await handler(new Request('https://executor.internal/health'))).status, 200);
  const other = new Request('https://executor.internal/nope', { method: 'POST' });
  assert.equal((await handler(other)).status, 404);
});
