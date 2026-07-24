// The tenant-boundary binder (ADR-0005 原則C-2). These tests are adversarial by
// design: the claim under test is that a caller cannot reach another tenant's
// data no matter how the SQL is shaped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRowScopeBound, bindQuery } from '../../../src/modules/executor/domain/bind.ts';
import type { QueryPolicy, TenantBinding } from '../../../src/modules/executor/domain/types.ts';

const POLICY: QueryPolicy = {
  tables: [
    { name: 'orders', scopeColumn: 'store_id' },
    { name: 'stores', scopeColumn: 'id' },
    { name: 'categories', scopeColumn: null }, // dimension: tenant-scoped, not row-scoped
  ],
};
const ALPHA: TenantBinding = {
  tenantId: 't_alpha',
  dataset: 't_alpha',
  scope: { kind: 'all' },
};
const ALPHA_S1: TenantBinding = {
  tenantId: 't_alpha',
  dataset: 't_alpha',
  scope: { kind: 'stores', storeIds: ['s1'] },
};

const bind = (sql: string, b: TenantBinding = ALPHA) => bindQuery(sql, b, POLICY);
const sqlOf = (r: ReturnType<typeof bind>): string => {
  assert.ok(r.ok, `expected success, got ${r.ok === false ? r.code : ''}`);
  return r.sql;
};

test('every physical table is qualified into the tenant dataset', () => {
  const sql = sqlOf(bind('SELECT category FROM orders'));
  assert.match(sql, /t_alpha\.orders/);
  assert.doesNotMatch(sql, /FROM\s+orders/i); // never left bare
});

test('joins qualify both sides', () => {
  const sql = sqlOf(bind('SELECT c.name FROM orders o JOIN categories c ON o.cat = c.id'));
  assert.match(sql, /t_alpha\.orders/);
  assert.match(sql, /t_alpha\.categories/);
});

test('CTE bodies are bound; the CTE name itself is not treated as a table', () => {
  const sql = sqlOf(
    bind('WITH top AS (SELECT category FROM orders) SELECT * FROM top ORDER BY category'),
  );
  assert.match(sql, /t_alpha\.orders/);
  assert.doesNotMatch(sql, /t_alpha\.top/); // the CTE is not a physical table
});

test('subqueries in FROM are bound', () => {
  const sql = sqlOf(bind('SELECT x.category FROM (SELECT category FROM orders) AS x'));
  assert.match(sql, /t_alpha\.orders/);
});

test('subqueries in WHERE are bound', () => {
  const sql = sqlOf(bind('SELECT category FROM categories WHERE id IN (SELECT cat FROM orders)'));
  assert.match(sql, /t_alpha\.categories/);
  assert.match(sql, /t_alpha\.orders/);
});

test('row scope wraps the table at its point of use, preserving the alias', () => {
  const sql = sqlOf(bind('SELECT o.category FROM orders o', ALPHA_S1));
  assert.match(sql, /store_id IN \('s1'\)/);
  assert.match(sql, /\)\s+AS o\b/); // alias kept so o.category still resolves
});

test('row scope applies to every occurrence, including inside a CTE and a join', () => {
  const sql = sqlOf(
    bind('WITH a AS (SELECT * FROM orders) SELECT * FROM a JOIN orders o ON a.id = o.id', ALPHA_S1),
  );
  const filters = sql.match(/store_id IN \('s1'\)/g) ?? [];
  assert.equal(filters.length, 2); // CTE body + the joined occurrence
});

test('an empty scope yields a filter that matches nothing (fail-closed)', () => {
  const empty: TenantBinding = {
    tenantId: 't_alpha',
    dataset: 't_alpha',
    scope: { kind: 'stores', storeIds: [] },
  };
  const sql = sqlOf(bind('SELECT category FROM orders', empty));
  assert.match(sql, /IN \(NULL\)/); // never degrades to "no filter"
});

test('a different tenant gets a different dataset from identical SQL', () => {
  const q = 'SELECT category FROM orders';
  const a = sqlOf(bind(q, ALPHA));
  const b = sqlOf(
    bindQuery(q, { tenantId: 't_bravo', dataset: 't_bravo', scope: { kind: 'all' } }, POLICY),
  );
  assert.match(a, /t_alpha\.orders/);
  assert.match(b, /t_bravo\.orders/);
  assert.doesNotMatch(b, /t_alpha/);
});

// --- refusals -------------------------------------------------------------

test('caller-supplied dataset qualification is refused (cross-tenant reach)', () => {
  const r = bind('SELECT category FROM t_bravo.orders');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'qualified-table-not-allowed');
});

test('a table outside the allowlist is refused', () => {
  const r = bind('SELECT * FROM secrets');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'table-not-allowed');
});

test('an unlisted table hidden in a subquery is still refused', () => {
  const r = bind('SELECT category FROM orders WHERE id IN (SELECT id FROM secrets)');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'table-not-allowed');
});

test('non-SELECT statements are refused', () => {
  for (const sql of [
    'DELETE FROM orders',
    'UPDATE orders SET category = 1',
    'INSERT INTO orders (category) VALUES (1)',
  ]) {
    const r = bind(sql);
    assert.equal(r.ok, false, sql);
    assert.equal(r.ok === false && r.code, 'not-a-select', sql);
  }
});

test('stacked statements are refused', () => {
  const r = bind('SELECT category FROM orders; DROP TABLE orders');
  assert.equal(r.ok, false);
  assert.ok(
    r.ok === false && ['not-a-single-statement', 'parse-error'].includes(r.code),
    `unexpected code ${r.ok === false ? r.code : ''}`,
  );
});

test('unparsable SQL is refused', () => {
  const r = bind('SELECT FROM WHERE');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'parse-error');
});

test('an unlisted table is refused in every SQL shape that can hide one', () => {
  const shapes = [
    'SELECT category FROM orders UNION ALL SELECT name FROM secrets',
    'SELECT (SELECT max(id) FROM secrets) AS m FROM orders',
    'SELECT * FROM orders o JOIN (SELECT id FROM secrets) s ON o.id = s.id',
    'SELECT * FROM (SELECT * FROM (SELECT * FROM secrets) a) b',
    'WITH a AS (SELECT id FROM secrets) SELECT * FROM a',
  ];
  for (const sql of shapes) {
    const r = bind(sql, ALPHA_S1);
    assert.equal(r.ok, false, sql);
    assert.equal(r.ok === false && r.code, 'table-not-allowed', sql);
  }
});

test('a backtick-qualified cross-tenant table is refused', () => {
  const r = bind('SELECT * FROM `t_bravo.orders`');
  assert.equal(r.ok, false);
});

test('UNION and comma joins bind every branch', () => {
  const union = sqlOf(
    bind('SELECT category FROM orders UNION ALL SELECT category FROM categories', ALPHA_S1),
  );
  assert.match(union, /t_alpha\.orders/);
  assert.match(union, /t_alpha\.categories/);
  assert.match(union, /store_id IN \('s1'\)/);
  const comma = sqlOf(bind('SELECT * FROM orders o, categories c', ALPHA_S1));
  assert.match(comma, /t_alpha\.orders/);
  assert.match(comma, /t_alpha\.categories/);
});

test('a CTE may shadow a table name without reaching the physical table', () => {
  const sql = sqlOf(bind('WITH orders AS (SELECT 1 AS x) SELECT * FROM orders', ALPHA_S1));
  assert.doesNotMatch(sql, /t_alpha\.orders/); // nothing physical was touched
});

test('reported tables list the bound physical tables (for audit)', () => {
  const r = bind('SELECT c.name FROM orders o JOIN categories c ON o.cat = c.id');
  assert.ok(r.ok);
  assert.deepEqual(r.tables, ['t_alpha.categories', 't_alpha.orders']);
});

test('query parameters survive the rewrite', () => {
  const sql = sqlOf(bind('SELECT category FROM orders WHERE created_at >= @since'));
  assert.match(sql, /@since/);
  assert.match(sql, /t_alpha\.orders/);
});

// --- ② row-scope self-check (ADR-0010, LOG-0040) -----------------------------
// Unlike ① tenant isolation, the row scope has no data-layer backstop: if the
// binder fails to wrap a table, nothing downstream notices. These pin the two
// halves of the fix — an undeclared policy is refused, and rewritten SQL is
// re-parsed and checked against the principal's actual scope.

test('a table whose policy omits scopeColumn is refused, not treated as unscoped', () => {
  const incomplete = { tables: [{ name: 'orders' }] } as unknown as QueryPolicy;
  const r = bindQuery('SELECT * FROM orders', ALPHA_S1, incomplete);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'policy-incomplete');
});

test('null scopeColumn is accepted — a dimension says "not row-scoped" out loud', () => {
  const sql = sqlOf(bind('SELECT name FROM categories', ALPHA_S1));
  assert.match(sql, /t_alpha\.categories/);
  assert.doesNotMatch(sql, /IN \('s1'\)/); // no filter invented for a dimension
});

test('the self-check accepts every shape the binder actually produces', () => {
  const shapes = [
    'SELECT category FROM orders',
    'SELECT c.name FROM orders o JOIN categories c ON o.cat = c.id',
    'SELECT * FROM orders WHERE id IN (SELECT id FROM stores)',
    'WITH x AS (SELECT * FROM orders) SELECT * FROM x',
    'SELECT category FROM orders UNION ALL SELECT category FROM categories',
    'SELECT (SELECT COUNT(*) FROM stores) AS n FROM orders',
  ];
  for (const sql of shapes) {
    assert.equal(
      assertRowScopeBound(sqlOf(bind(sql, ALPHA_S1)), ALPHA_S1.scope, POLICY),
      null,
      sql,
    );
  }
});

test('the self-check rejects a row-scoped table that escaped the wrapper', () => {
  const r = assertRowScopeBound('SELECT * FROM t_alpha.orders', ALPHA_S1.scope, POLICY);
  assert.equal(r?.ok, false);
  assert.match(r?.detail ?? '', /orders/);
});

test('the self-check rejects a filter carrying another principal stores', () => {
  const forged = "SELECT * FROM (SELECT * FROM t_alpha.orders WHERE store_id IN ('s9')) AS o";
  assert.equal(assertRowScopeBound(forged, ALPHA_S1.scope, POLICY)?.ok, false);
});

test('the self-check rejects a filter on the wrong column', () => {
  const forged = "SELECT * FROM (SELECT * FROM t_alpha.orders WHERE region IN ('s1')) AS o";
  assert.equal(assertRowScopeBound(forged, ALPHA_S1.scope, POLICY)?.ok, false);
});

test('one wrapped use does not excuse a second bare use of the same table', () => {
  const half =
    "SELECT * FROM (SELECT * FROM t_alpha.orders WHERE store_id IN ('s1')) AS a, t_alpha.orders b";
  assert.equal(assertRowScopeBound(half, ALPHA_S1.scope, POLICY)?.ok, false);
});

test('an all-rows principal has nothing to verify', () => {
  assert.equal(assertRowScopeBound('SELECT * FROM t_alpha.orders', ALPHA.scope, POLICY), null);
});
