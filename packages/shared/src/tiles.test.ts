import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateTiles,
  conductive,
  damageTopmost,
  indexOf,
  isPassage,
  topmostLayer,
  LayerKind,
} from './tiles.js';
import { L0_DOME_MAX_HP, L1_PANEL_MAX_HP } from './constants.js';

test('allocateTiles initializes L0 and L1 at max HP and L2/l1Charge empty', () => {
  const t = allocateTiles(3, 2);
  assert.equal(t.l0Hp.length, 6);
  assert.equal(t.l1Hp.length, 6);
  assert.equal(t.l2Kind.length, 6);
  assert.equal(t.l2Hp.length, 6);
  assert.equal(t.l1Charge.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(t.l0Hp[i], L0_DOME_MAX_HP);
    assert.equal(t.l1Hp[i], L1_PANEL_MAX_HP);
    assert.equal(t.l2Kind[i], 0);
    assert.equal(t.l2Hp[i], 0);
    assert.equal(t.l1Charge[i], 0);
  }
});

test('indexOf computes row-major offset', () => {
  assert.equal(indexOf(4, 0, 0), 0);
  assert.equal(indexOf(4, 3, 0), 3);
  assert.equal(indexOf(4, 0, 1), 4);
  assert.equal(indexOf(4, 2, 3), 14);
});

test('topmostLayer returns L2 when L2 present, L1 when L1 alive, L0 when only L0 left, null for passage', () => {
  const t = allocateTiles(1, 1);
  assert.equal(topmostLayer(t, 0), LayerKind.L1_PANEL); // default
  t.l2Kind[0] = 1; t.l2Hp[0] = 30;
  assert.equal(topmostLayer(t, 0), LayerKind.L2_ADDON);
  t.l2Hp[0] = 0; // L2 destroyed → falls through to L1
  assert.equal(topmostLayer(t, 0), LayerKind.L1_PANEL);
  t.l1Hp[0] = 0;
  assert.equal(topmostLayer(t, 0), LayerKind.L0_DOME);
  t.l0Hp[0] = 0;
  assert.equal(topmostLayer(t, 0), null);
});

test('conductive returns true above threshold, false below', () => {
  const t = allocateTiles(1, 1);
  assert.equal(conductive(t, 0), true);
  t.l1Hp[0] = Math.ceil(L1_PANEL_MAX_HP * 0.5);
  assert.equal(conductive(t, 0), true);
  t.l1Hp[0] = Math.ceil(L1_PANEL_MAX_HP * 0.5) - 1;
  assert.equal(conductive(t, 0), false);
  t.l1Hp[0] = 0;
  assert.equal(conductive(t, 0), false);
});

test('damageTopmost reduces the topmost layer HP and saturates at 0', () => {
  const t = allocateTiles(1, 1);
  damageTopmost(t, 0, 30);
  assert.equal(t.l1Hp[0], L1_PANEL_MAX_HP - 30);
  damageTopmost(t, 0, 1000); // overkill
  assert.equal(t.l1Hp[0], 0);
  // Now L0 is the topmost.
  damageTopmost(t, 0, 50);
  assert.equal(t.l0Hp[0], L0_DOME_MAX_HP - 50);
  damageTopmost(t, 0, 1000); // L0 overkill
  assert.equal(t.l0Hp[0], 0);
  // L2 absorption.
  t.l1Hp[0] = 50; // re-arm L1 so we can verify the L2 hit doesn't touch it
  t.l2Kind[0] = 1; t.l2Hp[0] = 40;
  damageTopmost(t, 0, 30);
  assert.equal(t.l2Hp[0], 10);
  assert.equal(t.l1Hp[0], 50); // L2 absorbed; L1 untouched
});

test('isPassage returns true only when L1 and L0 are both destroyed', () => {
  const t = allocateTiles(1, 1);
  assert.equal(isPassage(t, 0), false); // fresh tile
  t.l1Hp[0] = 0;
  assert.equal(isPassage(t, 0), false); // L1 gone, L0 intact
  t.l0Hp[0] = 0;
  assert.equal(isPassage(t, 0), true);  // both gone — passage
});
