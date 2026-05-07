import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_PREDICT_DT_S,
  PLAYER_DASH_COOLDOWN_S,
  PLAYER_DASH_DURATION_S,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
} from './constants.js';
import { createDefaultGrid } from './grid.js';
import { mulberry32 } from './rng.js';
import { newPlayerState, stepPlayer } from './sim.js';
import type { PlayerInput, PlayerState } from './types.js';

test('idle player stays put', () => {
  const grid = createDefaultGrid();
  let p: PlayerState = newPlayerState(0, 200, 200);
  for (let i = 0; i < 60; i++) p = stepPlayer(p, null, CLIENT_PREDICT_DT_S, grid);
  assert.equal(p.x, 200);
  assert.equal(p.y, 200);
  assert.equal(p.dashCooldownS, 0);
  assert.equal(p.dashRemainingS, 0);
  // stateSeq should advance every step
  assert.equal(p.stateSeq, 60);
});

test('movement integrates at expected speed', () => {
  const grid = createDefaultGrid();
  let p: PlayerState = newPlayerState(0, 200, 200);
  const input: PlayerInput = { tick: 0, clientTimeMs: 0, mx: 1, my: 0, dash: false };
  const seconds = 1;
  const steps = Math.round(seconds / CLIENT_PREDICT_DT_S);
  for (let i = 0; i < steps; i++) p = stepPlayer(p, input, CLIENT_PREDICT_DT_S, grid);
  // Should travel ~PLAYER_MOVE_SPEED px in 1s.
  assert.ok(Math.abs(p.x - (200 + PLAYER_MOVE_SPEED)) < 1, `x=${p.x}`);
  assert.equal(p.y, 200);
});

test('input is normalised to unit circle', () => {
  const grid = createDefaultGrid();
  let p: PlayerState = newPlayerState(0, 200, 200);
  // (3,4) → magnitude 5; should be normalised to (0.6, 0.8).
  const input: PlayerInput = { tick: 0, clientTimeMs: 0, mx: 3, my: 4, dash: false };
  const seconds = 1;
  const steps = Math.round(seconds / CLIENT_PREDICT_DT_S);
  for (let i = 0; i < steps; i++) p = stepPlayer(p, input, CLIENT_PREDICT_DT_S, grid);
  const expected = PLAYER_MOVE_SPEED * seconds;
  const traveled = Math.hypot(p.x - 200, p.y - 200);
  assert.ok(Math.abs(traveled - expected) < 1, `traveled=${traveled}`);
});

test('clamps to world bounds', () => {
  const grid = createDefaultGrid();
  let p: PlayerState = newPlayerState(0, 50, 50);
  const input: PlayerInput = { tick: 0, clientTimeMs: 0, mx: -1, my: -1, dash: false };
  for (let i = 0; i < 600; i++) p = stepPlayer(p, input, CLIENT_PREDICT_DT_S, grid);
  assert.equal(p.x, PLAYER_RADIUS);
  assert.equal(p.y, PLAYER_RADIUS);
});

test('dash starts only when cooldown is zero, then enters cooldown', () => {
  const grid = createDefaultGrid();
  let p: PlayerState = newPlayerState(0, 400, 400);
  const dashIn: PlayerInput = { tick: 0, clientTimeMs: 0, mx: 1, my: 0, dash: true };
  p = stepPlayer(p, dashIn, CLIENT_PREDICT_DT_S, grid);
  assert.ok(p.dashRemainingS > 0);
  assert.ok(p.dashCooldownS > 0);

  // After dash duration, dashRemaining is 0 but cooldown still nonzero.
  const ticksToFinish = Math.ceil(PLAYER_DASH_DURATION_S / CLIENT_PREDICT_DT_S) + 2;
  for (let i = 0; i < ticksToFinish; i++) p = stepPlayer(p, dashIn, CLIENT_PREDICT_DT_S, grid);
  assert.equal(p.dashRemainingS, 0);
  assert.ok(p.dashCooldownS > 0);

  // Pressing dash again during cooldown does nothing.
  const before = { ...p };
  p = stepPlayer(p, dashIn, CLIENT_PREDICT_DT_S, grid);
  assert.equal(p.dashRemainingS, 0);
  assert.ok(p.dashCooldownS < before.dashCooldownS);

  // Wait out cooldown, then dash should fire again.
  const ticksRemaining = Math.ceil(PLAYER_DASH_COOLDOWN_S / CLIENT_PREDICT_DT_S) + 2;
  for (let i = 0; i < ticksRemaining; i++) {
    p = stepPlayer(
      p,
      { tick: 0, clientTimeMs: 0, mx: 1, my: 0, dash: false },
      CLIENT_PREDICT_DT_S,
      grid,
    );
  }
  assert.equal(p.dashCooldownS, 0);
  p = stepPlayer(p, dashIn, CLIENT_PREDICT_DT_S, grid);
  assert.ok(p.dashRemainingS > 0);
});

test('replay is deterministic — same input sequence yields identical state', () => {
  const grid = createDefaultGrid();
  const rng = mulberry32(0xc0ffee);
  const inputs: PlayerInput[] = [];
  for (let i = 0; i < 600; i++) {
    inputs.push({
      tick: i,
      clientTimeMs: i * CLIENT_PREDICT_DT_S * 1000,
      mx: rng() * 2 - 1,
      my: rng() * 2 - 1,
      dash: rng() > 0.99,
    });
  }

  function run(): PlayerState {
    let p: PlayerState = newPlayerState(0, 500, 400);
    for (const inp of inputs) p = stepPlayer(p, inp, CLIENT_PREDICT_DT_S, grid);
    return p;
  }

  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'two independent replays must match exactly');
});
