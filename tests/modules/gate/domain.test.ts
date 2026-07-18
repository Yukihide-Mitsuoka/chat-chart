// Unit tests for the gate's pure domain layer. The full acceptance suite
// (ported from spikes/vertical-slice, LOG-0031) arrives with the adapters PR;
// these pin the domain invariants that suite builds on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalParams,
  denyKey,
  resultKey,
  shellKey,
} from '../../../src/modules/gate/domain/cache-key.ts';
import {
  checkEpoch,
  checkHasGrants,
  checkPayloadTenant,
  checkPrincipal,
  checkReportAllowed,
} from '../../../src/modules/gate/domain/decisions.ts';
import {
  allowedReports,
  canonicalScope,
  normalizeScope,
} from '../../../src/modules/gate/domain/scope.ts';
import type {
  AuthzContext,
  RoleGrant,
  TokenClaims,
} from '../../../src/modules/gate/domain/types.ts';

const grant = (dataScope: RoleGrant['dataScope'], reports: string[] = ['r_sales']): RoleGrant => ({
  dataScope,
  reports,
});
const ctx = (over: Partial<AuthzContext> = {}): AuthzContext => ({
  tenantId: 't_alpha',
  allowedReports: ['r_sales'],
  scope: { kind: 'all' },
  scopeHash: 'h',
  ...over,
});
const claims = (over: Partial<TokenClaims> = {}): TokenClaims => ({
  sub: 'alice',
  tenantId: 't_alpha',
  sessionId: 's1',
  epoch: 0,
  exp: 0,
  aud: 'gate',
  ...over,
});

test('scope: same effective scope canonicalizes identically across role shapes', () => {
  const a = normalizeScope([grant({ kind: 'stores', storeIds: ['s2', 's1'] })]);
  const b = normalizeScope([
    grant({ kind: 'stores', storeIds: ['s1'] }),
    grant({ kind: 'stores', storeIds: ['s2', 's1'] }),
  ]);
  assert.equal(canonicalScope(a), canonicalScope(b)); // dedup + sort → shared cache (§6)
  assert.equal(canonicalScope(a), 'stores:s1,s2');
});

test('scope: any all-rows grant absorbs scoped grants; different scopes stay distinct', () => {
  const all = normalizeScope([grant({ kind: 'stores', storeIds: ['s1'] }), grant({ kind: 'all' })]);
  assert.equal(canonicalScope(all), 'all');
  assert.notEqual(
    canonicalScope(normalizeScope([grant({ kind: 'stores', storeIds: ['s1'] })])),
    canonicalScope(normalizeScope([grant({ kind: 'stores', storeIds: ['s1', 's3'] })])),
  );
});

test('scope: allowedReports unions and dedups', () => {
  const rep = allowedReports([
    grant({ kind: 'all' }, ['r_b', 'r_a']),
    grant({ kind: 'all' }, ['r_a']),
  ]);
  assert.deepEqual(rep, ['r_a', 'r_b']);
});

test('keys: result key is a pure function of ctx — tenant and scope namespace it', () => {
  const k = resultKey(ctx(), 'q1', 'ph', 7);
  assert.equal(k, 'v1:t_alpha:h:q1:ph:7');
  assert.notEqual(k, resultKey(ctx({ tenantId: 't_bravo' }), 'q1', 'ph', 7));
  assert.notEqual(k, resultKey(ctx({ scopeHash: 'h2' }), 'q1', 'ph', 7));
  assert.notEqual(k, resultKey(ctx(), 'q1', 'ph', 8)); // data_version bump → new key (§5)
});

test('keys: shell key is tenant-agnostic and version-addressed (原則A/§5)', () => {
  assert.equal(shellKey('r_sales', 1), 'r_sales:1');
  assert.notEqual(shellKey('r_sales', 1), shellKey('r_sales', 2));
});

test('keys: canonicalParams is order-insensitive', () => {
  assert.equal(canonicalParams({ b: 1, a: 'x' }), canonicalParams({ a: 'x', b: 1 }));
  assert.notEqual(canonicalParams({ a: 'x' }), canonicalParams({ a: 'y' }));
});

test('keys: denylist key targets the user subject', () => {
  assert.equal(denyKey('bob'), 'v1:deny:user:bob');
});

test('decisions: principal must match the SoR, not the token claim', () => {
  assert.deepEqual(checkPrincipal(claims(), { tenantId: 't_alpha' }, true), { ok: true });
  const forged = checkPrincipal(claims({ tenantId: 't_alpha' }), { tenantId: 't_bravo' }, true);
  assert.equal(forged.ok, false);
  assert.equal(checkPrincipal(claims(), null, true).ok, false);
  assert.equal(checkPrincipal(claims(), { tenantId: 't_alpha' }, false).ok, false);
});

test('decisions: epoch mismatch rejects (revocation backstop)', () => {
  assert.equal(checkEpoch(claims({ epoch: 3 }), 2, 1).ok, true);
  assert.equal(checkEpoch(claims({ epoch: 3 }), 2, 2).ok, false);
});

test('decisions: zero grants deny — never an implicit all-rows scope', () => {
  assert.equal(checkHasGrants(0).ok, false);
  assert.equal(checkHasGrants(1).ok, true);
});

test('decisions: report allow-list and payload self-check (原則C-4)', () => {
  assert.equal(checkReportAllowed(ctx(), 'r_sales').ok, true);
  assert.equal(checkReportAllowed(ctx(), 'r_secret').ok, false);
  assert.equal(checkPayloadTenant('t_alpha', ctx()).ok, true);
  const leak = checkPayloadTenant('t_bravo', ctx());
  assert.equal(leak.ok, false);
  assert.equal(leak.ok === false && leak.status, 500);
});
