// Live proof that the Postgres control-plane adapters read authz correctly
// through RLS, against the real Neon project. Seeds a tenant as the owner, then
// reads it back through PgControlPlaneReader / PgBindingResolver as app_runtime,
// and confirms a second tenant's data is invisible.
//
//   node spikes/control-plane-neon/verify.mjs   (needs .env: DATABASE_URL, APP_RUNTIME_PASSWORD)
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { ControlPlaneDb } from '../../src/modules/control-plane/infrastructure/pg.ts';
import {
  PgControlPlaneReader,
  PgBindingResolver,
  PgAuditSink,
} from '../../src/modules/control-plane/infrastructure/adapters.ts';

for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const databaseUrl = process.env.DATABASE_URL;
const appPassword = process.env.APP_RUNTIME_PASSWORD;
if (!databaseUrl || !appPassword) {
  console.error('need DATABASE_URL and APP_RUNTIME_PASSWORD in .env');
  process.exit(2);
}

const owner = postgres(databaseUrl.replace('-pooler.', '.'), { max: 1, onnotice: () => {} });
const db = new ControlPlaneDb({ databaseUrl, appPassword });
const reader = new PgControlPlaneReader(db);
const binding = new PgBindingResolver(db, {
  tables: [{ name: 'orders', scopeColumn: 'store_id' }],
});
const audit = new PgAuditSink(db);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` (${extra})` : ''}`);
};

// tenants FKs do not cascade on tenant delete (off-boarding uses status='closed',
// not hard delete). For test cleanup, remove the direct children in FK order;
// the join tables cascade from users/roles/reports via their composite FKs.
async function cleanup(sql) {
  for (const t of ['audit_logs', 'revocation_events', 'datasources', 'users', 'roles', 'reports']) {
    await sql`delete from ${sql(t)} where tenant_id in (${A}, ${B})`.catch(() => {});
  }
  await sql`delete from tenants where id in (${A}, ${B})`.catch(() => {});
}

async function seed() {
  await cleanup(owner);
  const [v] =
    await owner`insert into vendors (name) values ('cp-verify') returning id`;
  for (const [id, name, store] of [
    [A, 'alpha', 's1'],
    [B, 'bravo', 's9'],
  ]) {
    await owner`insert into tenants (id, vendor_id, name, auth_epoch) values (${id}, ${v.id}, ${name}, 3)`;
    const [u] =
      await owner`insert into users (tenant_id, external_subject, auth_epoch) values (${id}, 'emb-user', 0) returning id`;
    const [r] =
      await owner`insert into roles (tenant_id, name, data_scope) values (${id}, 'manager', ${owner.json({ store_ids: [store] })}) returning id`;
    await owner`insert into user_roles (tenant_id, user_id, role_id) values (${id}, ${u.id}, ${r.id})`;
    const [rep] =
      await owner`insert into reports (tenant_id, slug, title, definition_ref, report_version) values (${id}, 'r_sales', 'Sales', 'ref', 4) returning id`;
    await owner`insert into role_reports (tenant_id, role_id, report_id) values (${id}, ${r.id}, ${rep.id})`;
    await owner`insert into report_queries (tenant_id, report_id, query_id, sql_text) values (${id}, ${rep.id}, 'q_sales', 'SELECT category FROM orders')`;
    await owner`insert into datasources (tenant_id, type, dataset, connection_ref, data_version) values (${id}, 'bigquery', ${name}, 'sm://ref', 7)`;
  }
}

async function main() {
  await seed();

  check('getTenantEpoch reads the tenant row', (await reader.getTenantEpoch(A)) === 3);
  check('unknown tenant epoch is null', (await reader.getTenantEpoch('33333333-3333-3333-3333-333333333333')) === null);

  const user = await reader.getUser(A, 'emb-user');
  check('getUser returns the embedded user with grants', user !== null && user.grants.length === 1);
  check('grant scope came from data_scope JSONB', JSON.stringify(user?.grants[0]?.dataScope) === JSON.stringify({ kind: 'stores', storeIds: ['s1'] }));
  check('grant reports resolve to the report slug', JSON.stringify(user?.grants[0]?.reports) === JSON.stringify(['r_sales']));

  check('getReportVersion by slug', (await reader.getReportVersion(A, 'r_sales')) === 4);
  check('getDataVersion', (await reader.getDataVersion(A)) === 7);

  const ds = await binding.resolve(A);
  check('BindingResolver returns the tenant dataset', ds?.dataset === 'alpha' && ds?.tenantId === A);
  check('QueryCatalog resolves queryId to SQL', (await binding.sqlFor(A, 'q_sales')) === 'SELECT category FROM orders');

  // The load-bearing one: tenant A's reader can never see tenant B, even though
  // both users share the same external_subject 'emb-user'.
  const asA = await reader.getUser(A, 'emb-user');
  const asB = await reader.getUser(B, 'emb-user');
  check("tenant A and B resolve DIFFERENT users for the same subject (RLS isolation)",
    JSON.stringify(asA?.grants[0]?.dataScope) !== JSON.stringify(asB?.grants[0]?.dataScope));
  check('B sees store s9, A sees store s1',
    JSON.stringify(asB?.grants[0]?.dataScope) === JSON.stringify({ kind: 'stores', storeIds: ['s9'] }));

  // audit_logs is INSERT-only for app_runtime (least privilege — the app writes
  // the trail but never reads it; audit reads are an owner/admin operation).
  await audit.record({ tenantId: A, action: 'query.execute', detail: { queryId: 'q_sales' } });
  const logged = await owner`select tenant_id, detail from audit_logs where tenant_id = ${A} and action = 'query.execute'`;
  check('audit sink writes the row under tenant A', logged.length === 1 && logged[0].detail.queryId === 'q_sales');

  // Write-side isolation: scoped to B, app_runtime cannot forge an audit row
  // for A — the WITH CHECK policy blocks it.
  let crossWriteBlocked = false;
  try {
    await db.withTenant(B, (tx) => tx`insert into audit_logs (tenant_id, action) values (${A}, 'forged')`);
  } catch {
    crossWriteBlocked = true;
  }
  check('tenant B cannot write an audit row for tenant A (WITH CHECK)', crossWriteBlocked);

  console.log(`\nresult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error('verify failed:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup(owner);
    await owner.end();
    await db.end();
  });
