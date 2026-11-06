import test from 'node:test';
import assert from 'node:assert/strict';
import { findOrders } from './order-service.mjs';
test('empty order query returns an array', () => assert.deepEqual(findOrders([]), []));
test('existing orders retain their shape', () => {
  const rows = [{ id: 'order-1', total: 42 }];
  assert.deepEqual(findOrders(rows), rows);
});
test('order values are not mutated', () => {
  const rows = Object.freeze([Object.freeze({ id: 'order-2', total: 0 })]);
  assert.strictEqual(findOrders(rows), rows);
});
