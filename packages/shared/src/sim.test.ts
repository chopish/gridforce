import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_PREDICT_DT_S,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  PLAYER_SPRINT_MULTIPLIER,
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
  assert.equal(p.panelJumpCooldownS, 0);
  // stateSeq should advance every step
  assert.equal(p.stateSeq, 60);
});

test('movement integrates at expected speed', () => {
  const grid = createDefaultGrid();
  let p: PlayerState = newPlayerState(0, 200, 200);
  const input: PlayerInput = { tick: 0, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 };
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
  const input: PlayerInput = { tick: 0, clientTimeMs: 0, mx: 3, my: 4, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 };
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
  const input: PlayerInput = { tick: 0, clientTimeMs: 0, mx: -1, my: -1, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 };
  for (let i = 0; i < 600; i++) p = stepPlayer(p, input, CLIENT_PREDICT_DT_S, grid);
  assert.equal(p.x, PLAYER_RADIUS);
  assert.equal(p.y, PLAYER_RADIUS);
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
      shock: false,
      repair: false,
      jumpHeld: rng() > 0.99,
      jumpCursorDx: 0,
      jumpCursorDy: 0,
      facingRad: 0,
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

test('sprint scales walk speed by PLAYER_SPRINT_MULTIPLIER', () => {
  const grid = createDefaultGrid();
  // Spawn somewhere away from walls so the clamp doesn't truncate the path.
  let state = newPlayerState(0, grid.cols * grid.panelSize / 2, grid.rows * grid.panelSize / 2);
  const dt = 1 / 30;
  const N = 30;
  for (let i = 0; i < N; i++) {
    state = stepPlayer(
      state,
      { tick: i, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
      dt,
      grid,
    );
  }
  const expected = grid.cols * grid.panelSize / 2 + PLAYER_MOVE_SPEED * PLAYER_SPRINT_MULTIPLIER * dt * N;
  assert.ok(
    Math.abs(state.x - expected) < 0.5,
    `sprint distance: got ${state.x}, expected ~${expected}`,
  );
});

test('walk speed unchanged when sprint=false', () => {
  const grid = createDefaultGrid();
  let state = newPlayerState(0, grid.cols * grid.panelSize / 2, grid.rows * grid.panelSize / 2);
  const dt = 1 / 30;
  for (let i = 0; i < 30; i++) {
    state = stepPlayer(
      state,
      { tick: i, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
      dt,
      grid,
    );
  }
  const expected = grid.cols * grid.panelSize / 2 + PLAYER_MOVE_SPEED * dt * 30;
  assert.ok(Math.abs(state.x - expected) < 0.5);
});

test('panel-jump teleports one panelSize in the input direction', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  const startY = grid.rows * grid.panelSize / 2;
  let state = newPlayerState(0, startX, startY);
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    1 / 30,
    grid,
  );
  assert.ok(Math.abs(state.x - (startX + grid.panelSize)) < 0.5, `x should advance one panel (got ${state.x})`);
  assert.ok(Math.abs(state.y - startY) < 0.5, 'y unchanged for pure horizontal jump');
  assert.ok(state.panelJumpCooldownS > 0, 'cooldown set after jump');
});

test('panel-jump from idle uses facing direction', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  const startY = grid.rows * grid.panelSize / 2;
  let state = newPlayerState(0, startX, startY);
  // Force facing to point straight up (negative y in screen coords).
  state = { ...state, facing: -Math.PI / 2 };
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 0, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    1 / 30,
    grid,
  );
  assert.ok(Math.abs(state.y - (startY - grid.panelSize)) < 0.5, 'y advances up one panel from facing');
});

test('panel-jump snaps direction to 8 octants', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  const startY = grid.rows * grid.panelSize / 2;
  // A ~60-degree input vector should snap to (1, 1) octant, landing diagonally one panel.
  let state = newPlayerState(0, startX, startY);
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 0.5, my: 0.866, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    1 / 30,
    grid,
  );
  assert.ok(Math.abs(state.x - (startX + grid.panelSize)) < 0.5);
  assert.ok(Math.abs(state.y - (startY + grid.panelSize)) < 0.5);
});

test('panel-jump clamps to world edge when target would land outside', () => {
  const grid = createDefaultGrid();
  const worldW = grid.cols * grid.panelSize;
  // Half a panel from the right edge — jumping right should land at the wall.
  let state = newPlayerState(0, worldW - grid.panelSize / 2, grid.rows * grid.panelSize / 2);
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    1 / 30,
    grid,
  );
  assert.equal(state.x, worldW - PLAYER_RADIUS);
});

test('panel-jump clamps both axes when jumping into a corner', () => {
  const grid = createDefaultGrid();
  const worldW = grid.cols * grid.panelSize;
  const worldH = grid.rows * grid.panelSize;
  // Place the player half a panel from the bottom-right corner; jump diagonally.
  let state = newPlayerState(0, worldW - grid.panelSize / 2, worldH - grid.panelSize / 2);
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 1, my: 1, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    1 / 30,
    grid,
  );
  assert.equal(state.x, worldW - PLAYER_RADIUS, 'x clamped at right wall');
  assert.equal(state.y, worldH - PLAYER_RADIUS, 'y clamped at bottom wall');
});

test('panel-jump updates facing so a chained idle jump uses the new direction', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 4;
  const startY = grid.rows * grid.panelSize / 2;
  let state = newPlayerState(0, startX, startY);
  // First jump: northeast via input vector. (positive x, positive y — note
  // we're in screen coordinates so positive y is "south" but that's fine
  // for this test.)
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 0.5, my: 0.866, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    1 / 30,
    grid,
  );
  const xAfterFirst = state.x;
  const yAfterFirst = state.y;
  // Force cooldown to zero so the second jump fires next tick.
  state = { ...state, panelJumpCooldownS: 0 };
  // Second jump: no input. Should reuse the facing set by the first jump.
  state = stepPlayer(
    state,
    { tick: 2, clientTimeMs: 0, mx: 0, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    1 / 30,
    grid,
  );
  assert.ok(state.x > xAfterFirst + 50, 'second jump kept east component');
  assert.ok(state.y > yAfterFirst + 50, 'second jump kept south component');
});

test('panel-jump cooldown is enforced', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  let state = newPlayerState(0, startX, grid.rows * grid.panelSize / 2);
  state = stepPlayer(state, { tick: 1, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }, 1 / 30, grid);
  const xAfterFirst = state.x;
  // Second dash 0.1s later. Should be ignored.
  state = stepPlayer(state, { tick: 2, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }, 0.1,    grid);
  assert.equal(state.x, xAfterFirst, 'second jump within cooldown does nothing');
});

test('panel-jump cooldown elapses', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 4;
  let state = newPlayerState(0, startX, grid.rows * grid.panelSize / 2);
  state = stepPlayer(state, { tick: 1, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }, 1 / 30, grid);
  // Tick forward 0.5s of idle ticks (longer than the 0.4s cooldown).
  for (let i = 0; i < 15; i++) {
    state = stepPlayer(state, { tick: 2 + i, clientTimeMs: 0, mx: 0, my: 0, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }, 1 / 30, grid);
  }
  assert.equal(state.panelJumpCooldownS, 0, 'cooldown drained');
  // Now a second jump should fire.
  state = stepPlayer(state, { tick: 100, clientTimeMs: 0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }, 1 / 30, grid);
  assert.ok(Math.abs(state.x - (startX + 2 * grid.panelSize)) < 0.5);
});
