import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_PREDICT_DT_S, PLAYER_MOVE_SPEED, PLAYER_RADIUS } from './constants.js';
import { createDefaultGrid } from './grid.js';
import { mulberry32 } from './rng.js';
import { newPlayerState, stepPlayer } from './sim.js';
import type { PlayerInput, PlayerState } from './types.js';

// Helper: a fully-formed v13 PlayerInput with all fields zeroed. Tests
// override just the fields they care about.
function makeInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    tick: 0,
    clientTimeMs: 0,
    mx: 0,
    my: 0,
    shock: false,
    repair: false,
    jumpHeld: false,
    jumpCursorDx: 0,
    jumpCursorDy: 0,
    facingRad: 0,
    ...overrides,
  };
}

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
  const input = makeInput({ mx: 1, my: 0 });
  const seconds = 1;
  const steps = Math.round(seconds / CLIENT_PREDICT_DT_S);
  for (let i = 0; i < steps; i++) p = stepPlayer(p, input, CLIENT_PREDICT_DT_S, grid);
  // Should travel ~PLAYER_MOVE_SPEED px in 1s.
  assert.ok(Math.abs(p.x - (200 + PLAYER_MOVE_SPEED)) < 1, `x=${p.x}`);
  assert.equal(p.y, 200);
});

test('player walks at PLAYER_MOVE_SPEED — no sprint multiplier in v13', () => {
  // v13 dropped sprint entirely. Walk speed is a flat PLAYER_MOVE_SPEED (308).
  // This test asserts the post-Task-1 baseline against a 1-second sim.
  const grid = createDefaultGrid();
  const p = newPlayerState(0, 500, 500);
  const next = stepPlayer(p, makeInput({ tick: 1, mx: 1, my: 0 }), 1.0, grid);
  const dx = next.x - p.x;
  // Allow some margin in case sim.ts ever applies sub-tick clamping; the
  // important thing is no x2 multiplier survives.
  assert.ok(
    dx > PLAYER_MOVE_SPEED - 8 && dx < PLAYER_MOVE_SPEED + 8,
    `expected ~${PLAYER_MOVE_SPEED} px movement, got ${dx}`,
  );
});

test('input is normalised to unit circle', () => {
  const grid = createDefaultGrid();
  let p: PlayerState = newPlayerState(0, 200, 200);
  // (3,4) → magnitude 5; should be normalised to (0.6, 0.8).
  const input = makeInput({ mx: 3, my: 4 });
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
  const input = makeInput({ mx: -1, my: -1 });
  for (let i = 0; i < 600; i++) p = stepPlayer(p, input, CLIENT_PREDICT_DT_S, grid);
  assert.equal(p.x, PLAYER_RADIUS);
  assert.equal(p.y, PLAYER_RADIUS);
});

test('replay is deterministic — same input sequence yields identical state', () => {
  const grid = createDefaultGrid();
  const rng = mulberry32(0xc0ffee);
  const inputs: PlayerInput[] = [];
  for (let i = 0; i < 600; i++) {
    inputs.push(
      makeInput({
        tick: i,
        clientTimeMs: i * CLIENT_PREDICT_DT_S * 1000,
        mx: rng() * 2 - 1,
        my: rng() * 2 - 1,
      }),
    );
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

test('panelJumpCooldownS decrements monotonically toward 0', () => {
  // In v13 the shared sim no longer performs panel jumps (that's server-side
  // now), but it must still tick the cooldown down so Room.ts has a single
  // source of truth for "is the jump available?".
  const grid = createDefaultGrid();
  let p: PlayerState = { ...newPlayerState(0, 200, 200), panelJumpCooldownS: 0.5 };
  p = stepPlayer(p, null, 0.1, grid);
  assert.ok(Math.abs(p.panelJumpCooldownS - 0.4) < 1e-9, `expected 0.4, got ${p.panelJumpCooldownS}`);
  // Tick past the cooldown — should saturate at 0, not go negative.
  for (let i = 0; i < 10; i++) p = stepPlayer(p, null, 0.1, grid);
  assert.equal(p.panelJumpCooldownS, 0);
});
