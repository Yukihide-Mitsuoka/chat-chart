// Migration runner. Zero dependencies beyond the postgres driver.
//
//   node migrations/run.mjs           # apply pending migrations
//   node migrations/run.mjs --status  # list applied / pending, change nothing
//
// Credentials come from .env (gitignored) or the environment — never from
// argv, never logged (GR-001/GR-003). DATABASE_URL may be the Neon pooler
// URL; migrations always run on the derived direct endpoint because DDL
// through transaction pooling is unreliable.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Minimal .env reader — KEY=VALUE lines, no expansion, values never logged. */
function loadDotEnv() {
  try {
    for (const line of readFileSync(join(HERE, '..', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env — environment variables may still be set */
  }
}

loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Put it in .env (gitignored) — see migrations/README.md');
  process.exit(2);
}
// Neon: the direct endpoint is the pooler host minus "-pooler".
const directUrl = url.replace('-pooler.', '.');

const sql = postgres(directUrl, { max: 1, onnotice: () => {} });

async function main() {
  await sql`create table if not exists schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  )`;
  const applied = new Set(
    (await sql`select filename from schema_migrations`).map((r) => r.filename),
  );
  const files = readdirSync(HERE).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

  if (process.argv.includes('--status')) {
    for (const f of files) console.log(`${applied.has(f) ? 'applied' : 'PENDING'}  ${f}`);
    return;
  }

  for (const f of files) {
    if (applied.has(f)) continue;
    const body = readFileSync(join(HERE, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (filename) values (${f})`;
    });
    console.log(`applied  ${f}`);
  }

  // app_runtime LOGIN password lives only in the environment (GR-001).
  const appPassword = process.env.APP_RUNTIME_PASSWORD;
  if (appPassword !== undefined) {
    if (!/^[A-Za-z0-9_-]{16,}$/.test(appPassword)) {
      console.error('APP_RUNTIME_PASSWORD must be >=16 chars of [A-Za-z0-9_-] — not applied');
      process.exitCode = 1;
    } else {
      await sql.unsafe(`alter role app_runtime login password '${appPassword}'`);
      console.log('app_runtime: login enabled (password from environment, not logged)');
    }
  } else {
    console.log('app_runtime: NOLOGIN (set APP_RUNTIME_PASSWORD to enable login)');
  }
}

main()
  .catch((e) => {
    // Never echo the failing SQL wholesale (it could be the ALTER ROLE line).
    console.error('migration failed:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => sql.end());
