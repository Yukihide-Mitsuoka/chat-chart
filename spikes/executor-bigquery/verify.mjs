// Live tenant-isolation measurement over real BigQuery, through the real
// pipeline: ExecuteQuery -> bindQuery -> BigQueryRunner.
import { ExecuteQuery } from '../../src/modules/executor/application/execute.ts';
import { MemoryBindingResolver, MemoryAuditSink } from '../../src/modules/executor/infrastructure/memory.ts';
import { BigQueryRunner } from '../../src/modules/executor/infrastructure/bigquery.ts';
import { AdcTokenProvider } from '../../src/modules/executor/infrastructure/google-auth.ts';

const POLICY = { tables: [{ name: 'orders', scopeColumn: 'store_id' }] };
const runner = new BigQueryRunner({ projectId: 'kotonoha-bi-dev', tokens: new AdcTokenProvider() });
const audit = new MemoryAuditSink();
const exec = new ExecuteQuery({
  bindings: new MemoryBindingResolver({
    t_alpha: { tenantId: 't_alpha', dataset: 't_alpha', scope: { kind: 'all' } },
    t_bravo: { tenantId: 't_bravo', dataset: 't_bravo', scope: { kind: 'all' } },
    t_alpha_s1: { tenantId: 't_alpha_s1', dataset: 't_alpha', scope: { kind: 'stores', storeIds: ['s1'] } },
  }, POLICY),
  runner, audit,
});

const Q = 'SELECT category, SUM(amount) AS total FROM orders GROUP BY category ORDER BY category';
const total = (r) => r.ok ? r.rows.reduce((s, x) => s + x.total, 0) : `ERR:${r.reason}`;

let pass = 0, fail = 0;
const check = (label, cond, extra='') => { cond ? pass++ : fail++; console.log(`${cond?'PASS':'FAIL'}  ${label} ${extra}`); };

// 1. Identical SQL, two tenants -> two datasets, each sees only its own totals
const a = await exec.execute('t_alpha', Q);
const b = await exec.execute('t_bravo', Q);
check('alpha total = 157900 (own data only)', total(a) === 157900, `got ${total(a)}`);
check('bravo total = 39500 (own data only)', total(b) === 39500, `got ${total(b)}`);
check('alpha bound SQL targets t_alpha', a.ok && a.sql.includes('t_alpha.orders') && !a.sql.includes('t_bravo'));
check('bravo bound SQL targets t_bravo', b.ok && b.sql.includes('t_bravo.orders') && !b.sql.includes('t_alpha'));

// 2. Cross-tenant reach is refused BEFORE BigQuery
const x = await exec.execute('t_alpha', 'SELECT * FROM t_bravo.orders');
check('alpha querying t_bravo.orders is refused pre-execution',
  !x.ok && x.status === 400 && x.reason === 'qualified-table-not-allowed');

// 3. Row scope applies on real data
const s1 = await exec.execute('t_alpha_s1', Q);
check('store-scoped alpha sees only s1 rows: 65000', total(s1) === 65000, `got ${total(s1)}`);

// 4. Named params work end-to-end on real BigQuery
const p = await exec.execute('t_alpha', 'SELECT COUNT(*) AS n FROM orders WHERE amount >= @min', { min: 30000 });
check('named param filters live rows (amount>=30000 -> 3)', p.ok && p.rows[0]?.n === 3, p.ok ? `got ${p.rows[0]?.n}` : p.reason);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
console.log('audit trail:', audit.actions().join(', '));
process.exit(fail === 0 ? 0 : 1);
