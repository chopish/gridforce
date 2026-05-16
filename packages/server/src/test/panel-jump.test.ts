import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import {
  PANEL_JUMP_COOLDOWN_S,
  allocateTiles,
  indexOf,
  type CrawlerState,
  type PlayerInput,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

// Internal handles into the Room. Mirrors the pattern used in shock.test.ts:
// cast through `unknown` to a minimal interface so tests can poke private
// state without making everything public.
interface RoomInternals {
  phase: string;
  hostId: number;
  tiles: TileBuffers;
  grid: { cols: number; rows: number; panelSize: number };
  states: Map<number, PlayerState>;
  crawlers: Map<number, CrawlerState>;
  carbons: Map<number, unknown>;
  pilots: Map<number, unknown>;
  physicsStep(): void;
}

const PLAYER_ID = 0;

function makeRoom(): RoomInternals {
  const room = new Room('JUMP', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.tiles = allocateTiles(r.grid.cols, r.grid.rows);
  r.crawlers.clear();
  r.carbons.clear();
  return r;
}

function setPlayerAt(r: RoomInternals, cx: number, cy: number): void {
  const x = cx * r.grid.panelSize + r.grid.panelSize / 2;
  const y = cy * r.grid.panelSize + r.grid.panelSize / 2;
  r.states.set(PLAYER_ID, {
    id: PLAYER_ID,
    x, y,
    facing: 0,
    facingCursorRad: 0,
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name: 'p',
    ready: true,
    carbon: 0,
    shockCooldownS: 0,
    repairProgressS: 0,
    shockHeldS: 0,
  });
}

interface JumpInputOpts {
  jumpHeld: boolean;
  jumpCursorDx: number;
  jumpCursorDy: number;
}

function makePilot(opts: JumpInputOpts): unknown {
  return {
    isBot: false,
    ready: true,
    name: 'p',
    ackInputTick: 0,
    computeAckBitmask: () => 0,
    send: () => {},
    dispose: () => {},
    consumeInputForTick: (): PlayerInput => ({
      tick: 0,
      clientTimeMs: 0,
      mx: 0,
      my: 0,
      shock: false,
      repair: false,
      jumpHeld: opts.jumpHeld,
      jumpCursorDx: opts.jumpCursorDx,
      jumpCursorDy: opts.jumpCursorDy,
      facingRad: 0,
    }),
  };
}

// Set the pilot only once; the consumeInputForTick closure is stable.
function inputPlayer(r: RoomInternals, opts: JumpInputOpts): void {
  r.pilots.set(PLAYER_ID, makePilot(opts));
}

// Same as inputPlayer but explicit "holding" naming for the rising-edge tick.
function inputPlayerHolding(r: RoomInternals, opts: JumpInputOpts): void {
  r.pilots.set(PLAYER_ID, makePilot(opts));
}

function tick(r: RoomInternals): void {
  r.physicsStep();
}

function playerState(r: RoomInternals): PlayerState {
  return r.states.get(PLAYER_ID)!;
}

test('release of jumpHeld with cursor (1, 0) teleports the player one tile east', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  // Hold for one tick.
  inputPlayerHolding(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  // Release.
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  const pl = playerState(room);
  const panelSize = room.grid.panelSize;
  assert.ok(
    Math.abs(pl.x - (6 * panelSize + panelSize / 2)) < 1,
    `expected x ≈ ${6 * panelSize + panelSize / 2}, got ${pl.x}`,
  );
  assert.ok(
    Math.abs(pl.y - (5 * panelSize + panelSize / 2)) < 1,
    `expected y ≈ ${5 * panelSize + panelSize / 2}, got ${pl.y}`,
  );
  assert.ok(
    pl.panelJumpCooldownS > 0,
    `expected cooldown > 0, got ${pl.panelJumpCooldownS}`,
  );
});

test('release with cursor (0, 0) is a cancel (no teleport)', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  inputPlayerHolding(room, { jumpHeld: true, jumpCursorDx: 0, jumpCursorDy: 0 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0 });
  tick(room);
  const pl = playerState(room);
  const panelSize = room.grid.panelSize;
  // Player did NOT move.
  assert.ok(
    Math.abs(pl.x - (5 * panelSize + panelSize / 2)) < 1,
    `expected x ≈ ${5 * panelSize + panelSize / 2}, got ${pl.x}`,
  );
  // Cancel does not consume cooldown.
  assert.equal(pl.panelJumpCooldownS, 0);
});

test('jump onto an L-1 passage is rejected', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  const targetIdx = indexOf(room.grid.cols, 6, 5);
  room.tiles.l0Hp[targetIdx] = 0;
  room.tiles.l1Hp[targetIdx] = 0;
  inputPlayerHolding(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  const pl = playerState(room);
  const panelSize = room.grid.panelSize;
  // Did NOT move.
  assert.ok(
    Math.abs(pl.x - (5 * panelSize + panelSize / 2)) < 1,
    `expected x ≈ ${5 * panelSize + panelSize / 2}, got ${pl.x}`,
  );
  // Rejection (passage) does not consume cooldown.
  assert.equal(pl.panelJumpCooldownS, 0);
});

test('panel-jump cooldown blocks a second jump within PANEL_JUMP_COOLDOWN_S', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  // First jump: 1 east.
  inputPlayerHolding(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  const after1 = playerState(room);
  assert.ok(after1.panelJumpCooldownS > 0);
  // Immediate second jump attempt.
  inputPlayerHolding(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  const pl = playerState(room);
  const panelSize = room.grid.panelSize;
  // Still at (6,5), not (7,5).
  assert.ok(
    Math.abs(pl.x - (6 * panelSize + panelSize / 2)) < 1,
    `expected x ≈ ${6 * panelSize + panelSize / 2}, got ${pl.x}`,
  );
});

test('jump with cursor at axis cap (2, -1) lands on the correct tile', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  inputPlayerHolding(room, { jumpHeld: true, jumpCursorDx: 2, jumpCursorDy: -1 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 2, jumpCursorDy: -1 });
  tick(room);
  const pl = playerState(room);
  const panelSize = room.grid.panelSize;
  // Should be at (7, 4).
  assert.ok(
    Math.abs(pl.x - (7 * panelSize + panelSize / 2)) < 1,
    `expected x ≈ ${7 * panelSize + panelSize / 2}, got ${pl.x}`,
  );
  assert.ok(
    Math.abs(pl.y - (4 * panelSize + panelSize / 2)) < 1,
    `expected y ≈ ${4 * panelSize + panelSize / 2}, got ${pl.y}`,
  );
});

// Document the unused-import guard for PANEL_JUMP_COOLDOWN_S — tests assert
// "cooldown > 0" rather than equality so tick decrement doesn't matter.
void PANEL_JUMP_COOLDOWN_S;
