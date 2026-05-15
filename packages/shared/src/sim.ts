import {
  PANEL_JUMP_COOLDOWN_S,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  PLAYER_SPRINT_MULTIPLIER,
} from './constants.js';
import type { GridDef, PlayerInput, PlayerState } from './types.js';

const FACING_EPSILON = 1e-3;
const INPUT_DEADZONE = 0.1;

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

// Snap a direction vector to one of the 8 octants. Returns integer dx, dy
// in {-1, 0, +1}, not both zero. Caller has already verified the source
// vector is non-degenerate.
function snapDirToOctant(dx: number, dy: number): { dx: number; dy: number } {
  const a = Math.atan2(dy, dx);
  const bucket = Math.round(a / (Math.PI / 4)); // -4..4
  const wrapped = ((bucket % 8) + 8) % 8;
  const table = [
    { dx: 1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: -1 },
  ];
  return table[wrapped]!;
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
  let wantJump = false;
  let sprint = false;
  if (input) {
    mx = clamp(input.mx, -1, 1);
    my = clamp(input.my, -1, 1);
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    wantJump = !!input.dash;
    sprint = !!input.sprint;
  }

  if (panelJumpCooldownS > 0) panelJumpCooldownS = Math.max(0, panelJumpCooldownS - dt);

  // Panel-jump: discrete teleport. Direction is the input vector if non-
  // negligible, otherwise the current facing. Snap to 8 octants, clamp to
  // grid bounds.
  if (wantJump && panelJumpCooldownS === 0) {
    let dirX = mx,
      dirY = my;
    if (Math.hypot(dirX, dirY) < INPUT_DEADZONE) {
      dirX = Math.cos(facing);
      dirY = Math.sin(facing);
    }
    const oct = snapDirToOctant(dirX, dirY);
    x += oct.dx * grid.panelSize;
    y += oct.dy * grid.panelSize;
    // Update facing to the jump direction so the next idle-jump uses it.
    facing = Math.atan2(oct.dy, oct.dx);
    panelJumpCooldownS = PANEL_JUMP_COOLDOWN_S;
  }

  // Walk integration (sprint multiplier applies only here).
  // Walk is suppressed on any tick where the dash button is held — the player
  // either just jumped or is holding dash while on cooldown; either way the
  // directional stick controls the jump target, not a simultaneous walk.
  if (!wantJump) {
    const walk = sprint ? PLAYER_MOVE_SPEED * PLAYER_SPRINT_MULTIPLIER : PLAYER_MOVE_SPEED;
    const vx = mx * walk;
    const vy = my * walk;
    x += vx * dt;
    y += vy * dt;
    if (Math.hypot(vx, vy) > FACING_EPSILON) {
      facing = Math.atan2(vy, vx);
    }
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
