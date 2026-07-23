// Pure row → domain mapping. The queries themselves are proven live against
// Neon (spikes/control-plane-neon); these pin the shaping that turns JSONB and
// join rows into the exact types the gate consumes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataScope,
  rowsToGrants,
} from '../../../src/modules/control-plane/infrastructure/mapping.ts';

test('empty data_scope means all rows', () => {
  assert.deepEqual(parseDataScope({}), { kind: 'all' });
});

test('store_ids map to a store scope, sorted for stable hashing', () => {
  assert.deepEqual(parseDataScope({ store_ids: ['s2', 's1'] }), {
    kind: 'stores',
    storeIds: ['s1', 's2'],
  });
});

test('unrecognized or malformed scope fails safe to all (never crashes)', () => {
  // 'all' is the conservative default here: a role with a scope we cannot parse
  // is caught upstream by normalizeScope + the report allow-list, not by leaking.
  for (const raw of [null, undefined, 42, 'nope', [], { store_ids: 'x' }, { store_ids: [1, 2] }]) {
    assert.deepEqual(parseDataScope(raw), { kind: 'all' }, JSON.stringify(raw));
  }
});

test('rows become grants; null report slugs from the left join are dropped', () => {
  const grants = rowsToGrants([
    { data_scope: {}, reports: ['r_sales', null, 'r_ops'] },
    { data_scope: { store_ids: ['s1'] }, reports: [null] },
  ]);
  assert.deepEqual(grants, [
    { dataScope: { kind: 'all' }, reports: ['r_sales', 'r_ops'] },
    { dataScope: { kind: 'stores', storeIds: ['s1'] }, reports: [] },
  ]);
});

test('a user with no roles yields no grants', () => {
  assert.deepEqual(rowsToGrants([]), []);
});
