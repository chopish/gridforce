import test from 'node:test';
import assert from 'node:assert/strict';

import { L0_DOME_MAX_HP, L1_PANEL_MAX_HP } from '@gridforce/shared';

import { tileColor } from './MinimapRenderer.js';

test('LIVE-conductive tile resolves to live kind', () => {
  const c = tileColor(L1_PANEL_MAX_HP, L0_DOME_MAX_HP);
  assert.equal(c.kind, 'live');
});

test('DAMAGED tile resolves to damaged kind', () => {
  const c = tileColor(Math.floor(L1_PANEL_MAX_HP * 0.4), L0_DOME_MAX_HP);
  assert.equal(c.kind, 'damaged');
});

test('L1-gone tile resolves to dome kind', () => {
  const c = tileColor(0, L0_DOME_MAX_HP);
  assert.equal(c.kind, 'dome');
});

test('Passage tile resolves to passage kind', () => {
  const c = tileColor(0, 0);
  assert.equal(c.kind, 'passage');
});
