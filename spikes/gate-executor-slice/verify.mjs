// The full vertical slice on real data: a vendor-signed JWT enters the gate's
// HTTP handler, authorization is resolved, the executor compiles the tenant
// boundary into the SQL, BigQuery runs it, and the result is cached in KV.
//
// This is the Node composition root described in worker.ts: it injects the real
// executor (BigQuery + ADC) into buildGate. On Cloudflare the production
// topology is gate → HTTP → executor service instead, because ADC is Node-only.
//
// Run: node spikes/gate-executor-slice/verify.mjs   (needs gcloud ADC)
import { buildGate } from '../../src/modules/gate/interface/worker.ts';
import { createHandler } from '../../src/modules/gate/interface/handler.ts';
import { ExecutorQueryAdapter } from '../../src/modules/gate/infrastructure/executor-adapter.ts';
import { ExecuteQuery } from '../../src/modules/executor/application/execute.ts';
import { MemoryBindingResolver, MemoryAuditSink } from '../../src/modules/executor/infrastructure/memory.ts';
import { BigQueryRunner } from '../../src/modules/executor/infrastructure/bigquery.ts';
import { AdcTokenProvider } from '../../src/modules/executor/infrastructure/google-auth.ts';

// --- vendor side: mint the embed JWT the gate expects ----------------------
const b64u = (b) => btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const jsonB64u = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
async function mint(claims) {
  const input = `${jsonB64u({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${jsonB64u(claims)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64u(new Uint8Array(sig))}`;
}

// --- KV stand-in (Workers KV shape) ---------------------------------------
class FakeKv {
  store = new Map();
  async get(k) { return this.store.get(k) ?? null; }
  async put(k, v) { this.store.set(k, v); }
}
const resultKv = new FakeKv();
const env = {
  RESULT_KV: resultKv, AUTHZ_KV: new FakeKv(), DENYLIST_KV: new FakeKv(), SHELL_KV: new FakeKv(),
  VENDOR_KEYS: JSON.stringify({ k1: publicJwk }), GATE_AUDIENCE: 'gate',
};

// --- real executor over real BigQuery -------------------------------------
const audit = new MemoryAuditSink();
const executor = new ExecutorQueryAdapter({
  execute: new ExecuteQuery({
    bindings: new MemoryBindingResolver(
      { t_demo: { tenantId: 't_demo', dataset: 't_alpha' } }, // demo tenant reads the t_alpha fixture
      { tables: [{ name: 'orders', scopeColumn: 'store_id' }] },
    ),
    runner: new BigQueryRunner({ projectId: 'kotonoha-bi-dev', tokens: new AdcTokenProvider() }),
    audit,
  }),
  catalog: {
    async sqlFor(_tenantId, queryId) {
      return queryId === 'q_sales_by_category'
        ? 'SELECT category, SUM(amount) AS total FROM orders GROUP BY category ORDER BY category'
        : null;
    },
  },
});

const handler = createHandler(buildGate(env, { executor }));
const token = await mint({
  sub: 'u_demo', tenant_id: 't_demo', sid: 'sess_demo', aud: 'gate',
  epoch: 0, exp: Math.floor(Date.now() / 1000) + 300,
});
const get = (path) => new Request(`https://gate.example${path}`, { headers: { authorization: `Bearer ${token}` } });

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };

// 1. Shell (①) — tenant-agnostic, no warehouse involved
const shell = await handler(get('/r/r_demo'));
check('shell served (① cache)', shell.status === 200);

// 2. Data (②) — full path through BigQuery
const first = await handler(get('/r/r_demo/data/q_sales_by_category'));
const body = first.status === 200 ? await first.json() : { rows: [], cached: null };
const total = body.rows.reduce((s, r) => s + r.total, 0);
check('data served from live BigQuery', first.status === 200, `status ${first.status}`);
check('rows are the real t_alpha fixture (157900)', total === 157900, `got ${total}`);
check('first call was a cache miss', body.cached === false);

// 3. Second call is served from KV, without touching BigQuery
const second = await handler(get('/r/r_demo/data/q_sales_by_category'));
const body2 = await second.json();
check('second call hits the ② result cache', body2.cached === true);
check('② payload persisted to KV', resultKv.store.size === 1, `entries ${resultKv.store.size}`);
check('cached rows equal the live rows', JSON.stringify(body2.rows) === JSON.stringify(body.rows));

// 4. An unauthenticated request never reaches the warehouse
const anon = await createHandler(buildGate(env, { executor }))(new Request('https://gate.example/r/r_demo/data/q_sales_by_category'));
check('no token → 401', anon.status === 401);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
console.log('executor audit:', audit.actions().join(', '));
process.exit(fail === 0 ? 0 : 1);
