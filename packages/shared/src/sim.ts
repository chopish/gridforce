import {
  PLAYER_DASH_COOLDOWN_S,
  PLAYER_DASH_DURATION_S,
  PLAYER_DASH_SPEED,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
} from './constants.js';
import type { GridDef, PlayerInput, PlayerState } from './types.js';

const FACING_EPSILON = 1e-3;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function newPlayerState(id: number, x: number, y: number): PlayerState {
  return {
    id,
    x,
    y,
    facing: 0,
    dashCooldownS: 0,
    dashRemainingS: 0,
    stateSeq: 0,
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
  let { x, y, facing, dashCooldownS, dashRemainingS } = state;
  const stateSeq = (state.stateSeq + 1) >>> 0;

  // Sanitize input on the consumer side too — server clamps as well, but the
  // shared sim must never trust raw values from the wire.
  let mx = 0;
  let my = 0;
  let wantDash = false;
  if (input) {
    mx = clamp(input.mx, -1, 1);
    my = clamp(input.my, -1, 1);
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    wantDash = !!input.dash;
  }

  if (dashCooldownS > 0) dashCooldownS = Math.max(0, dashCooldownS - dt);
  if (dashRemainingS > 0) dashRemainingS = Math.max(0, dashRemainingS - dt);

  if (wantDash && dashCooldownS === 0 && dashRemainingS === 0) {
    dashRemainingS = PLAYER_DASH_DURATION_S;
    dashCooldownS = PLAYER_DASH_COOLDOWN_S;
  }

  let vx: number;
  let vy: number;
  if (dashRemainingS > 0) {
    const mag = Math.hypot(mx, my);
    if (mag > FACING_EPSILON) {
      vx = (mx / mag) * PLAYER_DASH_SPEED;
      vy = (my / mag) * PLAYER_DASH_SPEED;
    } else {
      vx = Math.cos(facing) * PLAYER_DASH_SPEED;
      vy = Math.sin(facing) * PLAYER_DASH_SPEED;
    }
  } else {
    vx = mx * PLAYER_MOVE_SPEED;
    vy = my * PLAYER_MOVE_SPEED;
  }

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

  return { id: state.id, x, y, facing, dashCooldownS, dashRemainingS, stateSeq };
}

export function isDashing(state: PlayerState): boolean {
  return state.dashRemainingS > 0;
}
