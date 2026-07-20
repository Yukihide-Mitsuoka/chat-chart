// The execute use case. The assertions that matter are about *what reaches the
// runner*: nothing unbound, never another tenant's dataset, params passed as
// parameters rather than interpolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecuteQuery } from '../../../src/modules/executor/application/execute.ts';
import {
  MemoryAuditSink,
  MemoryBindingResolver,
  RecordingQueryRunner,
} from '../../../src/modules/executor/infrastructure/memory.ts';
import type { DataScope, QueryPolicy } from '../../../src/modules/executor/domain/types.ts';
import type { TenantDataset } from '../../../src/modules/executor/application/ports.ts';

const POLICY: QueryPolicy = {
  tables: [{ name: 'orders', scopeColumn: 'store_id' }, { name: 'categories' }],
};
const ALPHA: TenantDataset = { tenantId: 't_alpha', dataset: 't_alpha' };
const BRAVO: TenantDataset = { tenantId: 't_bravo', dataset: 't_bravo' };
const ALL: DataScope = { kind: 'all' };
const S9: DataScope = { kind: 'stores', storeIds: ['s9'] };

function harness(bindings: Record<string, TenantDataset> = { t_alpha: ALPHA, t_bravo: BRAVO }) {
  const runner = new RecordingQueryRunner();
  const audit = new MemoryAuditSink();
  const exec = new ExecuteQuery({
    bindings: new MemoryBindingResolver(bindings, POLICY),
    runner,
    audit,
  });
  return { exec, runner, audit };
}

test('the runner only ever sees bound SQL', async () => {
  const { exec, runner } = harness();
  runner.willReturn([{ category: 'A' }]);
  const r = await exec.execute('t_alpha', 'SELECT category FROM orders', {}, ALL);
  assert.ok(r.ok);
  assert.match(runner.lastSql ?? '', /t_alpha\.orders/);
  assert.doesNotMatch(runner.lastSql ?? '', /FROM\s+orders/i);
});

test('the same query run by two tenants hits two different datasets', async () => {
  const { exec, runner } = harness();
  await exec.execute('t_alpha', 'SELECT category FROM orders', {}, ALL);
  await exec.execute('t_bravo', 'SELECT category FROM orders', {}, S9);
  const [a, b] = runner.calls.map((c) => c.sql);
  assert.match(a ?? '', /t_alpha\.orders/);
  assert.match(b ?? '', /t_bravo\.orders/);
  assert.doesNotMatch(b ?? '', /t_alpha/);
  assert.match(b ?? '', /store_id IN \('s9'\)/); // bravo's row scope came along
});

test('a refused query never reaches the runner and is audited', async () => {
  const { exec, runner, audit } = harness();
  const r = await exec.execute('t_alpha', 'SELECT * FROM t_bravo.orders', {}, ALL);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
  assert.equal(r.ok === false && r.reason, 'qualified-table-not-allowed');
  assert.equal(runner.calls.length, 0); // nothing executed
  assert.deepEqual(audit.actions(), ['query.refused']);
});

test('DML is refused before execution', async () => {
  const { exec, runner } = harness();
  const r = await exec.execute('t_alpha', 'DELETE FROM orders', {}, ALL);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
  assert.equal(runner.calls.length, 0);
});

test('an unknown tenant is refused without touching the runner', async () => {
  const { exec, runner } = harness();
  const r = await exec.execute('t_ghost', 'SELECT category FROM orders', {}, ALL);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 404);
  assert.equal(runner.calls.length, 0);
});

test('a resolver returning a mismatched binding is refused (defence in depth)', async () => {
  // Simulates the worst resolver bug: t_alpha resolves to bravo's binding.
  const { exec, runner } = harness({ t_alpha: BRAVO });
  const r = await exec.execute('t_alpha', 'SELECT category FROM orders', {}, ALL);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 500);
  assert.equal(r.ok === false && r.reason, 'binding-tenant-mismatch');
  assert.equal(runner.calls.length, 0); // bravo's dataset was never queried
});

test('named parameters are passed through, not interpolated', async () => {
  const { exec, runner } = harness();
  await exec.execute(
    't_alpha',
    'SELECT category FROM orders WHERE created_at >= @since',
    { since: '2026-01-01' },
    ALL,
  );
  assert.deepEqual(runner.calls[0]?.params, { since: '2026-01-01' });
  assert.match(runner.lastSql ?? '', /@since/); // still a placeholder
  assert.doesNotMatch(runner.lastSql ?? '', /2026-01-01/); // value not in the SQL
});

test('a runner failure surfaces as 500 and is audited, without leaking the driver message', async () => {
  const { exec, runner, audit } = harness();
  runner.willFail('bigquery: quota exceeded for project xyz');
  const r = await exec.execute('t_alpha', 'SELECT category FROM orders', {}, ALL);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 500);
  assert.equal(r.ok === false && r.reason, 'execution-failed'); // generic to the caller
  assert.deepEqual(audit.actions(), ['query.failed']);
  assert.match(audit.events[0]?.detail['reason'] ?? '', /quota exceeded/); // detail kept audit-side
});

test('a successful run audits the bound SQL and the tables it touched', async () => {
  const { exec, audit } = harness();
  await exec.execute(
    't_alpha',
    'SELECT c.name FROM orders o JOIN categories c ON o.cat = c.id',
    {},
    ALL,
  );
  assert.deepEqual(audit.actions(), ['query.execute']);
  const detail = audit.events[0]?.detail ?? {};
  assert.match(detail['sql'] ?? '', /t_alpha\.orders/); // evidence the boundary applied
  assert.equal(detail['tables'], 't_alpha.categories,t_alpha.orders');
});

test('an audit-sink outage does not fail an otherwise successful query', async () => {
  const runner = new RecordingQueryRunner();
  runner.willReturn([{ category: 'A' }]);
  const exec = new ExecuteQuery({
    bindings: new MemoryBindingResolver({ t_alpha: ALPHA }, POLICY),
    runner,
    audit: {
      async record() {
        throw new Error('audit store unreachable');
      },
    },
  });
  const r = await exec.execute('t_alpha', 'SELECT category FROM orders', {}, ALL);
  assert.ok(r.ok);
  assert.deepEqual(r.rows, [{ category: 'A' }]);
});
