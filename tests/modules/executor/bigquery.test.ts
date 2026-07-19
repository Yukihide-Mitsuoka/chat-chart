// BigQuery runner over a fake fetch — no network, no credentials. The
// assertions cover the request we send (parameters, never interpolation) and
// the failure modes where a wrong answer would be worse than an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BigQueryRunner,
  type FetchLike,
} from '../../../src/modules/executor/infrastructure/bigquery.ts';

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeFetch(
  response: unknown,
  opts: { ok?: boolean; status?: number; raw?: string } = {},
): { fetchImpl: FetchLike; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    captured.push({
      url,
      body: JSON.parse(init.body) as Record<string, unknown>,
      headers: init.headers,
    });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      async text() {
        return opts.raw ?? JSON.stringify(response);
      },
    };
  };
  return { fetchImpl, captured };
}

const tokens = {
  async getToken() {
    return 'test-token';
  },
};
const runner = (fetchImpl: FetchLike, maxRows?: number) =>
  new BigQueryRunner({
    projectId: 'kotonoha-bi-dev',
    tokens,
    fetchImpl,
    ...(maxRows !== undefined && { maxRows }),
  });

const OK_RESPONSE = {
  jobComplete: true,
  schema: {
    fields: [
      { name: 'category', type: 'STRING' },
      { name: 'total', type: 'INTEGER' },
    ],
  },
  rows: [{ f: [{ v: 'A' }, { v: '40000' }] }, { f: [{ v: 'B' }, { v: '25000' }] }],
};

test('decodes rows into typed objects using the schema', async () => {
  const { fetchImpl } = fakeFetch(OK_RESPONSE);
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.ok(r.ok);
  assert.deepEqual(r.rows, [
    { category: 'A', total: 40000 },
    { category: 'B', total: 25000 },
  ]);
});

test('values are sent as named parameters, never interpolated into the SQL', async () => {
  const { fetchImpl, captured } = fakeFetch(OK_RESPONSE);
  const sql = 'SELECT category FROM t_alpha.orders WHERE created_at >= @since AND n > @n';
  await runner(fetchImpl).run(sql, { since: '2026-01-01', n: 5 });
  const body = captured[0]?.body ?? {};
  assert.equal(body['query'], sql); // SQL passed through untouched
  assert.equal(body['parameterMode'], 'NAMED');
  assert.equal(body['useLegacySql'], false);
  assert.deepEqual(body['queryParameters'], [
    { name: 'since', parameterType: { type: 'STRING' }, parameterValue: { value: '2026-01-01' } },
    { name: 'n', parameterType: { type: 'INT64' }, parameterValue: { value: '5' } },
  ]);
});

test('parameter types are inferred per value', async () => {
  const { fetchImpl, captured } = fakeFetch(OK_RESPONSE);
  await runner(fetchImpl).run('SELECT 1', { s: 'x', i: 7, f: 1.5, b: true });
  const types = (
    captured[0]?.body['queryParameters'] as { name: string; parameterType: { type: string } }[]
  ).map((p) => [p.name, p.parameterType.type]);
  assert.deepEqual(types, [
    ['s', 'STRING'],
    ['i', 'INT64'],
    ['f', 'FLOAT64'],
    ['b', 'BOOL'],
  ]);
});

test('the access token is sent as a bearer credential', async () => {
  const { fetchImpl, captured } = fakeFetch(OK_RESPONSE);
  await runner(fetchImpl).run('SELECT 1', {});
  assert.equal(captured[0]?.headers['authorization'], 'Bearer test-token');
  assert.match(captured[0]?.url ?? '', /projects\/kotonoha-bi-dev\/queries$/);
});

test('an integer too large for a JS number is kept as a string', async () => {
  const { fetchImpl } = fakeFetch({
    jobComplete: true,
    schema: { fields: [{ name: 'big', type: 'INT64' }] },
    rows: [{ f: [{ v: '9007199254740993' }] }],
  });
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.ok(r.ok);
  assert.deepEqual(r.rows, [{ big: '9007199254740993' }]); // not silently rounded
});

test('booleans and nulls decode correctly', async () => {
  const { fetchImpl } = fakeFetch({
    jobComplete: true,
    schema: {
      fields: [
        { name: 'flag', type: 'BOOL' },
        { name: 'missing', type: 'STRING' },
      ],
    },
    rows: [{ f: [{ v: 'true' }, { v: null }] }, { f: [{ v: 'false' }, {}] }],
  });
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.ok(r.ok);
  assert.deepEqual(r.rows, [
    { flag: true, missing: null },
    { flag: false, missing: null },
  ]);
});

test('an empty result set is success with no rows', async () => {
  const { fetchImpl } = fakeFetch({ jobComplete: true, schema: { fields: [] } });
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.ok(r.ok);
  assert.deepEqual(r.rows, []);
});

// --- failure modes: an error must never masquerade as a complete answer ----

test('an incomplete job is an error, not a partial result', async () => {
  const { fetchImpl } = fakeFetch({ jobComplete: false, rows: [{ f: [{ v: 'A' }] }] });
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /did not complete/);
});

test('a paged result is an error rather than a silent truncation', async () => {
  const { fetchImpl } = fakeFetch({ ...OK_RESPONSE, pageToken: 'more' });
  const r = await runner(fetchImpl, 2).run('SELECT 1', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /exceeds maxRows \(2\)/);
});

test('an HTTP error surfaces the API message', async () => {
  const { fetchImpl } = fakeFetch(
    { error: { message: 'Access Denied: Table t_bravo.orders' } },
    { ok: false, status: 403 },
  );
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /Access Denied/);
});

test('a job-level error is reported even on HTTP 200', async () => {
  const { fetchImpl } = fakeFetch({
    jobComplete: true,
    errors: [{ message: 'Syntax error at [1:1]' }],
  });
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /Syntax error/);
});

test('an unparsable body is an error, not a crash', async () => {
  const { fetchImpl } = fakeFetch(null, { raw: '<html>gateway timeout</html>', status: 504 });
  const r = await runner(fetchImpl).run('SELECT 1', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /unparsable response/);
});

test('a transport failure is an error, not a throw', async () => {
  const boom: FetchLike = async () => {
    throw new Error('ECONNRESET');
  };
  const r = await runner(boom).run('SELECT 1', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /request failed: ECONNRESET/);
});

test('missing credentials are an error, not a throw', async () => {
  const { fetchImpl } = fakeFetch(OK_RESPONSE);
  const r = await new BigQueryRunner({
    projectId: 'p',
    tokens: {
      async getToken() {
        throw new Error('reauth required');
      },
    },
    fetchImpl,
  }).run('SELECT 1', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /credentials unavailable: reauth required/);
});
