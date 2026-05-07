import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, gridPixelHeight, gridPixelWidth } from './grid.js';
import { createPlayer, simulate } from './sim.js';
import type { PlayerInput, WorldState } from './types.js';
import {
  PLAYER_DASH_DURATION_S,
  PLAYER_MOVE_SPEED,
  TICK_DT_S,
} from './constants.js';

function freshState(): WorldState {
  const grid = createGrid(16, 12);
  const player = createPlayer('p1', 'Alice', false, 200, 200);
  return { tick: 0, grid, players: [player], rngState: 12345 };
}

function input(tick: number, mx: number, my: number, dash = false): PlayerInput {
  return { tick, mx, my, dash };
}

test('player at rest stays at rest with zero input', () => {
  const s0 = freshState();
  const inputs = new Map([['p1', input(0, 0, 0)]]);
  const s1 = simulate(s0, inputs, TICK_DT_S);
  assert.equal(s1.tick, 1);
  assert.equal(s1.players[0]!.x, 200);
  assert.equal(s1.players[0]!.y, 200);
});

test('player moves at PLAYER_MOVE_SPEED for full input', () => {
  const s0 = freshState();
  const inputs = new Map([['p1', input(0, 1, 0)]]);
  const s1 = simulate(s0, inputs, TICK_DT_S);
  const expectedDx = PLAYER_MOVE_SPEED * TICK_DT_S;
  assert.ok(Math.abs(s1.players[0]!.x - (200 + expectedDx)) < 1e-6);
});

test('diagonal input does not exceed PLAYER_MOVE_SPEED', () => {
  const s0 = freshState();
  const inputs = new Map([['p1', input(0, 1, 1)]]);
  const s1 = simulate(s0, inputs, TICK_DT_S);
  const dx = s1.players[0]!.x - 200;
  const dy = s1.players[0]!.y - 200;
  const speed = Math.hypot(dx, dy) / TICK_DT_S;
  assert.ok(Math.abs(speed - PLAYER_MOVE_SPEED) < 1e-3, `speed=${speed}`);
});

test('player clamps to grid bounds', () => {
  const s0 = freshState();
  let s = { ...s0, players: [{ ...s0.players[0]!, x: 10 }] };
  const inputs = new Map([['p1', input(0, -1, 0)]]);
  for (let i = 0; i < 30; i++) {
    s = simulate(s, inputs, TICK_DT_S);
  }
  assert.ok(s.players[0]!.x > 0, 'player should not pass through left wall');
});

test('dash triggers high speed for one duration', () => {
  const s0 = freshState();
  const dashInput = new Map([['p1', input(0, 1, 0, true)]]);
  const holdInput = new Map([['p1', input(0, 1, 0, false)]]);
  let s = simulate(s0, dashInput, TICK_DT_S);
  // Just after dash trigger, vx should be very high
  assert.ok(s.players[0]!.vx > PLAYER_MOVE_SPEED * 2, 'dash should boost vx');
  // After dash duration, dashTimer should be 0
  const ticksToEndDash = Math.ceil(PLAYER_DASH_DURATION_S / TICK_DT_S) + 1;
  for (let i = 0; i < ticksToEndDash; i++) {
    s = simulate(s, holdInput, TICK_DT_S);
  }
  assert.equal(s.players[0]!.dashTimer, 0);
});

test('dash on cooldown does not retrigger', () => {
  const s0 = freshState();
  const dashInput = new Map([['p1', input(0, 1, 0, true)]]);
  let s = simulate(s0, dashInput, TICK_DT_S);
  const v0 = s.players[0]!.vx;
  // Try to dash again immediately
  s = simulate(s, dashInput, TICK_DT_S);
  // vx should not jump higher (dash already in progress / cooldown blocking re-trigger)
  assert.ok(s.players[0]!.vx <= v0 + 1, 'second dash should not re-boost');
});

test('determinism: same inputs from same seed produce same state', () => {
  const inputsArr: PlayerInput[] = [];
  for (let t = 0; t < 100; t++) {
    inputsArr.push(input(t, Math.cos(t * 0.31), Math.sin(t * 0.27), t % 17 === 0));
  }

  function run(): WorldState {
    let s = freshState();
    for (const inp of inputsArr) {
      const m = new Map([['p1', inp]]);
      s = simulate(s, m, TICK_DT_S);
    }
    return s;
  }

  const a = run();
  const b = run();
  assert.equal(a.tick, b.tick);
  assert.equal(a.players[0]!.x, b.players[0]!.x);
  assert.equal(a.players[0]!.y, b.players[0]!.y);
});

test('grid pixel size is consistent', () => {
  const g = createGrid(10, 8);
  assert.equal(gridPixelWidth(g), 10 * 64);
  assert.equal(gridPixelHeight(g), 8 * 64);
});
