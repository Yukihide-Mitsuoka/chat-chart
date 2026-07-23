// Verifies the applied control-plane schema enforces tenant isolation, as
// app_runtime (the only principal RLS constrains). Same assertions the
// rls-isolation spike proved on the representative subset, now on the real
// production schema. Runs against whatever DATABASE_URL points at — a local
// Docker Postgres in CI-style checks, or Neon.
//
//   node migrations/verify.mjs   # connects as app_runtime (derived from
//                                  DATABASE_URL host + APP_RUNTIME_PASSWORD)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(HERE, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be set */
}

const ownerUrl = (process.env.DATABASE_URL ?? '').replace('-pooler.', '.');
if (!ownerUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}
// The app_runtime connection is always derived from the owner URL's host plus
// APP_RUNTIME_PASSWORD, so that password has exactly one source of truth (the
// value the runner set on the role). Deliberately NOT a separate URL var — two
// hand-written copies of one password only ever drift apart.
function appRuntimeUrl() {
  const pw = process.env.APP_RUNTIME_PASSWORD;
  if (!pw) {
    console.error('APP_RUNTIME_PASSWORD is not set (the app_runtime login password)');
    process.exit(2);
  }
  const u = new URL(ownerUrl);
  u.username = 'app_runtime';
  u.password = pw;
  return u.toString();
}
const appUrl = appRuntimeUrl();

const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
const app = postgres(appUrl, { max: 1, onnotice: () => {} });

const ALPHA = '11111111-1111-1111-1111-111111111111';
const BRAVO = '22222222-2222-2222-2222-222222222222';
let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` (${extra})` : ''}`);
};

async function seed() {
  // As the owner (bypasses RLS), plant two tenants with one user each.
  await owner`delete from users where tenant_id in (${ALPHA}, ${BRAVO})`;
  await owner`delete from tenants where id in (${ALPHA}, ${BRAVO})`;
  const [v] = await owner`
    insert into vendors (name) values ('verify-vendor')
    on conflict do nothing returning id`;
  const vendorId = v?.id ?? (await owner`select id from vendors limit 1`)[0].id;
  await owner`insert into tenants (id, vendor_id, name) values
    (${ALPHA}, ${vendorId}, 'alpha'), (${BRAVO}, ${vendorId}, 'bravo')`;
  await owner`insert into users (tenant_id, external_subject, email) values
    (${ALPHA}, 'a', 'a@alpha'), (${BRAVO}, 'b', 'b@bravo')`;
}

/** Run fn inside a tx with app.tenant_id set to `tenant` (or unset). */
async function asTenant(tenant, fn) {
  return app.begin(async (tx) => {
    if (tenant) await tx`select set_config('app.tenant_id', ${tenant}, true)`;
    return fn(tx);
  });
}

async function main() {
  await seed();

  const alphaRows = await asTenant(ALPHA, (tx) => tx`select email from users`);
  check('alpha sees only its user (bare SELECT, no WHERE)', alphaRows.length === 1 && alphaRows[0].email === 'a@alpha');

  const bravoRows = await asTenant(BRAVO, (tx) => tx`select email from users`);
  check('bravo sees only its user', bravoRows.length === 1 && bravoRows[0].email === 'b@bravo');

  const unset = await asTenant(null, (tx) => tx`select count(*)::int as n from users`);
  check('unset tenant sees zero rows (fail-closed)', unset[0].n === 0);

  const crossRead = await asTenant(ALPHA, (tx) => tx`select count(*)::int as n from users where tenant_id = ${BRAVO}`);
  check('alpha cannot read bravo rows by id', crossRead[0].n === 0);

  let blocked = false;
  try {
    await asTenant(ALPHA, (tx) => tx`insert into users (tenant_id, external_subject) values (${BRAVO}, 'x')`);
  } catch {
    blocked = true;
  }
  check('alpha cannot INSERT into bravo (WITH CHECK)', blocked);

  let noDelete = false;
  try {
    await asTenant(ALPHA, (tx) => tx`delete from users where tenant_id = ${ALPHA}`);
  } catch {
    noDelete = true;
  }
  check('app_runtime has no DELETE (least privilege)', noDelete);

  console.log(`\nresult: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error('verify failed:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner`delete from users where tenant_id in (${ALPHA}, ${BRAVO})`.catch(() => {});
    await owner`delete from tenants where id in (${ALPHA}, ${BRAVO})`.catch(() => {});
    await owner.end();
    await app.end();
  });
