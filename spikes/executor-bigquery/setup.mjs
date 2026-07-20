// One-time setup (owner-approved 2026-07-20): per-tenant datasets in
// kotonoha-bi-dev with tiny seed rows (KB-scale, free tier).
import { BigQueryRunner } from '../../src/modules/executor/infrastructure/bigquery.ts';
import { AdcTokenProvider } from '../../src/modules/executor/infrastructure/google-auth.ts';

const runner = new BigQueryRunner({ projectId: 'kotonoha-bi-dev', tokens: new AdcTokenProvider() });
const steps = [
  'CREATE SCHEMA IF NOT EXISTS t_alpha',
  'CREATE SCHEMA IF NOT EXISTS t_bravo',
  `CREATE OR REPLACE TABLE t_alpha.orders (store_id STRING, category STRING, amount INT64)`,
  `CREATE OR REPLACE TABLE t_bravo.orders (store_id STRING, category STRING, amount INT64)`,
  `INSERT INTO t_alpha.orders (store_id, category, amount) VALUES
     ('s1','A',40000),('s1','B',25000),('s2','A',52900),('s2','C',30000),('s2','D',10000)`,
  `INSERT INTO t_bravo.orders (store_id, category, amount) VALUES
     ('s9','X',20000),('s9','Y',12000),('s9','Z',7500)`,
];
for (const sql of steps) {
  const r = await runner.run(sql, {});
  console.log(r.ok ? 'ok ' : `FAIL(${r.reason}) `, sql.slice(0, 60).replace(/\s+/g, ' '));
  if (!r.ok) process.exit(1);
}
