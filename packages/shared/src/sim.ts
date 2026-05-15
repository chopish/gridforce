import {
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  PLAYER_SPRINT_MULTIPLIER,
} from './constants.js';
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
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name,
    ready: false,
  };
}

// Pure deterministic step. Server runs this authoritatively;
// client runs it for prediction. Same inputs + same starting state → same result.
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
  let sprint = false;
  if (input) {
    mx = clamp(input.mx, -1, 1);
    my = clamp(input.my, -1, 1);
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    sprint = !!input.sprint;
  }

  if (panelJumpCooldownS > 0) panelJumpCooldownS = Math.max(0, panelJumpCooldownS - dt);

  // TODO(Task 4): panel-jump burst replaces the old dash burst here.
  // For now, just walk-integrate (no dash burst).

  const walk = sprint ? PLAYER_MOVE_SPEED * PLAYER_SPRINT_MULTIPLIER : PLAYER_MOVE_SPEED;
  const vx = mx * walk;
  const vy = my * walk;

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
    panelJumpCooldownS,
    stateSeq,
    // Roster metadata is opaque to the sim — pass through unchanged.
    name: state.name,
    ready: state.ready,
  };
}
