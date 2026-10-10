import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bitmap } from '../src/bitmap.js';

test('set/get/popcount', () => {
  const b = Bitmap.empty(100);
  [0, 31, 32, 63, 99].forEach(i => b.set(i));
  assert.equal(b.popcount(), 5);
  assert.ok(b.get(31) && b.get(32) && b.get(99));
  assert.ok(!b.get(30));
});

test('full() masks the tail so popcount is exact', () => {
  for (const n of [1, 31, 32, 33, 64, 100, 1500]) {
    assert.equal(Bitmap.full(n).popcount(), n, `size ${n}`);
  }
});

test('boolean algebra', () => {
  const a = Bitmap.empty(64); [1, 2, 3].forEach(i => a.set(i));
  const b = Bitmap.empty(64); [3, 4, 5].forEach(i => b.set(i));
  assert.deepEqual(a.clone().and(b).page(0, 10), [3]);
  assert.deepEqual(a.clone().or(b).page(0, 10), [1, 2, 3, 4, 5]);
  assert.deepEqual(a.clone().xor(b).page(0, 10), [1, 2, 4, 5]);
  assert.deepEqual(a.clone().andNot(b).page(0, 10), [1, 2]);
});

test('select(k) is the k-th set bit', () => {
  const b = Bitmap.empty(300);
  const ids = [5, 70, 71, 200, 299];
  ids.forEach(i => b.set(i));
  ids.forEach((id, k) => assert.equal(b.select(k), id, `select(${k})`));
  assert.equal(b.select(ids.length), -1);
});

test('after() is cursor continuation, both directions', () => {
  const b = Bitmap.empty(200);
  const ids = [3, 10, 11, 50, 120, 199];
  ids.forEach(i => b.set(i));
  assert.deepEqual(b.after(null, 3), [3, 10, 11]);
  assert.deepEqual(b.after(11, 3), [50, 120, 199]);
  assert.deepEqual(b.after(null, 2, true), [199, 120]);
  assert.deepEqual(b.after(120, 2, true), [50, 11]);
});

test('round-trips through bytes', () => {
  const a = Bitmap.empty(1500);
  for (let i = 0; i < 1500; i += 7) a.set(i);
  const b = Bitmap.fromBytes(1500, a.toBytes());
  assert.equal(b.popcount(), a.popcount());
  assert.deepEqual(b.page(0, 1000), a.page(0, 1000));
});
