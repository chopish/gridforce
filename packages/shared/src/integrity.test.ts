import test from 'node:test';
import assert from 'node:assert/strict';
import { damagePerSecond } from './integrity.js';
import { BASE_DOT_RATE, WEIGHT_THRESHOLD, TILE_LAYER_ARMOR_MAX } from './constants.js';

test('zero weight = zero damage', () => {
  assert.equal(damagePerSecond(0, 0), 0);
});

test('linear regime below threshold', () => {
  assert.equal(damagePerSecond(1, 0), BASE_DOT_RATE * 1);
  assert.equal(damagePerSecond(2, 0), BASE_DOT_RATE * 2);
  assert.equal(damagePerSecond(WEIGHT_THRESHOLD, 0), BASE_DOT_RATE * WEIGHT_THRESHOLD);
});

test('quadratic regime above threshold', () => {
  // w = threshold + 1 → BASE_DOT_RATE × ((threshold+1) + 1)
  const w = WEIGHT_THRESHOLD + 1;
  assert.equal(damagePerSecond(w, 0), BASE_DOT_RATE * (w + 1));
  // w = threshold + 2 → quadratic kick = 4
  const w2 = WEIGHT_THRESHOLD + 2;
  assert.equal(damagePerSecond(w2, 0), BASE_DOT_RATE * (w2 + 4));
});

test('5 bugs collapse a 100 HP panel ~6× faster than 1 bug', () => {
  const dps1 = damagePerSecond(1, 0);
  const dps5 = damagePerSecond(5, 0);
  // 1 bug: 2 hp/s; 5 bugs: 2*(5 + 1) = 12 hp/s; ratio 6.
  assert.equal(dps5 / dps1, 6);
});

test('armor scales damage to zero at max', () => {
  assert.equal(damagePerSecond(3, TILE_LAYER_ARMOR_MAX), 0);
  // Half armor → half damage.
  const halfArmor = TILE_LAYER_ARMOR_MAX / 2;
  assert.equal(damagePerSecond(3, halfArmor), damagePerSecond(3, 0) / 2);
});
