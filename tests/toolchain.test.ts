// Smoke test proving the toolchain runs TypeScript through node:test.
// Replaced by the gate module's acceptance suite (#23) as soon as it lands.
import test from 'node:test';
import assert from 'node:assert/strict';

test('node runs TypeScript tests with types stripped', () => {
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  assert.equal(sum([1, 2, 3]), 6);
});
