// The gate↔executor bridge. The assertions that matter: the gate's row scope
// reaches the SQL, the gate can never redirect the dataset, and a policy
// refusal of stored report SQL is not reported as a client error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorQueryAdapter } from '../../../src/modules/gate/infrastructure/executor-adapter.ts';
import type { QueryCatalog } from '../../../src/modules/executor/application/ports.ts';
import { ExecuteQuery } from '../../../src/modules/executor/application/execute.ts';
import {
  MemoryAuditSink,
  MemoryBindingResolver,
  RecordingQueryRunner,
} from '../../../src/modules/executor/infrastructure/memory.ts';
import type { AuthzContext } from '../../../src/modules/gate/domain/types.ts';

const POLICY = { tables: [{ name: 'orders', scopeColumn: 'store_id' }] };
const SQL = 'SELECT category, SUM(amount) AS total FROM orders GROUP BY category';

const catalog: QueryCatalog = {
  async sqlFor(_tenantId, queryId) {
    return queryId === 'q_sales' ? SQL : null;
  },
};

function harness(cat: QueryCatalog = catalog) {
  const runner = new RecordingQueryRunner();
  const audit = new MemoryAuditSink();
  const adapter = new ExecutorQueryAdapter({
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
    catalog: cat,
  });
  return { adapter, runner, audit };
}

const ctx = (over: Partial<AuthzContext> = {}): AuthzContext => ({
  tenantId: 't_alpha',
  allowedReports: ['r_sales'],
  scope: { kind: 'all' },
  scopeHash: 'h',
  ...over,
});

test('a query flows through to bound SQL in the caller tenant dataset', async () => {
  const { adapter, runner } = harness();
  runner.willReturn([{ category: 'A', total: 1 }]);
  const r = await adapter.execute(ctx(), 'q_sales', {});
  assert.ok(r.ok);
  assert.deepEqual(r.rows, [{ category: 'A', total: 1 }]);
  assert.match(runner.lastSql ?? '', /t_alpha\.orders/);
});

test("the gate's row scope reaches the SQL — the key's scope and the filter agree", async () => {
  const { adapter, runner } = harness();
  await adapter.execute(ctx({ scope: { kind: 'stores', storeIds: ['s1'] } }), 'q_sales', {});
  assert.match(runner.lastSql ?? '', /store_id IN \('s1'\)/);
});

test('the same query for another tenant targets that tenant dataset only', async () => {
  const { adapter, runner } = harness();
  await adapter.execute(ctx({ tenantId: 't_bravo' }), 'q_sales', {});
  assert.match(runner.lastSql ?? '', /t_bravo\.orders/);
  assert.doesNotMatch(runner.lastSql ?? '', /t_alpha/);
});

test('an unknown query id is 404 and never reaches the runner', async () => {
  const { adapter, runner } = harness();
  const r = await adapter.execute(ctx(), 'q_missing', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 404);
  assert.equal(runner.calls.length, 0);
});

test('an unknown tenant is 404', async () => {
  const { adapter } = harness();
  const r = await adapter.execute(ctx({ tenantId: 't_ghost' }), 'q_sales', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 404);
});

test('stored report SQL that violates policy is 500, not a client error', async () => {
  // The end user did not author this SQL, so a refusal is our bug to fix.
  const { adapter, runner } = harness({
    async sqlFor() {
      return 'SELECT * FROM t_bravo.orders';
    },
  });
  const r = await adapter.execute(ctx(), 'q_sales', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 500);
  assert.equal(r.ok === false && r.reason, 'qualified-table-not-allowed');
  assert.equal(runner.calls.length, 0);
});

test('named parameters are forwarded as parameters', async () => {
  const { adapter, runner } = harness({
    async sqlFor() {
      return 'SELECT category FROM orders WHERE amount >= @min';
    },
  });
  await adapter.execute(ctx(), 'q_sales', { min: 100 });
  assert.deepEqual(runner.calls[0]?.params, { min: 100 });
  assert.match(runner.lastSql ?? '', /@min/);
});

test('execution failures surface as 500 with a generic reason', async () => {
  const { adapter, runner } = harness();
  runner.willFail('bigquery: quota exceeded for project xyz');
  const r = await adapter.execute(ctx(), 'q_sales', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 500);
  assert.equal(r.ok === false && r.reason, 'execution-failed');
});
