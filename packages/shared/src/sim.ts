import { PLAYER_MOVE_SPEED, PLAYER_RADIUS } from './constants.js';
import type { GridDef, PlayerInput, PlayerState } from './types.js';

const FACING_EPSILON = 1e-3;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function newPlayerState(id: number, x: number, y: number, name = ''): PlayerState {
  return {
    id,
    x,
    y,
    facing: 0,
    facingCursorRad: 0,
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name,
    ready: false,
    carbon: 0,
    shockCooldownS: 0,
    repairProgressS: 0,
    shockHeldS: 0,
  };
}

// Pure deterministic step. Server runs this authoritatively;
// client runs it for prediction. Same inputs + same starting state → same result.
//
// v13: sprint is gone — walk speed is always PLAYER_MOVE_SPEED. The discrete
// panel-jump (was `input.dash`) is also gone from the shared sim; the new
// hold-Shift + cursor panel-jump is server-authoritative and lives in
// Room.ts. sim.ts still tracks `panelJumpCooldownS` on PlayerState and
// decrements it per tick so the server's jump path can read a single
// source of truth.
export function stepPlayer(
  state: PlayerState,
  input: PlayerInput | null,
  dt: number,
  grid: GridDef,
): PlayerState {
  let { x, y, facing, panelJumpCooldownS } = state;
  const stateSeq = (state.stateSeq + 1) >>> 0;

  // Sanitize input on the consumer side too — server clamps as well, but the
  // shared sim must never trust raw values from the wire.
  let mx = 0;
  let my = 0;
  if (input) {
    mx = clamp(input.mx, -1, 1);
    my = clamp(input.my, -1, 1);
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
  }

  if (panelJumpCooldownS > 0) panelJumpCooldownS = Math.max(0, panelJumpCooldownS - dt);

  // Walk integration at constant PLAYER_MOVE_SPEED — no sprint multiplier in v13.
  const vx = mx * PLAYER_MOVE_SPEED;
  const vy = my * PLAYER_MOVE_SPEED;
  x += vx * dt;
  y += vy * dt;
  if (Math.hypot(vx, vy) > FACING_EPSILON) {
    facing = Math.atan2(vy, vx);
  }

  const minX = PLAYER_RADIUS;
  const minY = PLAYER_RADIUS;
  const maxX = grid.cols * grid.panelSize - PLAYER_RADIUS;
  const maxY = grid.rows * grid.panelSize - PLAYER_RADIUS;
  x = clamp(x, minX, maxX);
  y = clamp(y, minY, maxY);

  return {
    id: state.id,
    x,
    y,
    facing,
    facingCursorRad: state.facingCursorRad,
    panelJumpCooldownS,
    stateSeq,
    // Roster metadata is opaque to the sim — pass through unchanged.
    name: state.name,
    ready: state.ready,
    // Electrical-defense fields are opaque to the base sim — pass through unchanged.
    carbon: state.carbon,
    shockCooldownS: state.shockCooldownS,
    repairProgressS: state.repairProgressS,
    shockHeldS: state.shockHeldS,
  };
}
