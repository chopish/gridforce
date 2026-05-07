import {
  PLAYER_DASH_COOLDOWN_S,
  PLAYER_DASH_DURATION_S,
  PLAYER_DASH_SPEED,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  TILE_SIZE,
} from './constants.js';
import { gridPixelHeight, gridPixelWidth } from './grid.js';
import type { Player, PlayerInput, WorldState } from './types.js';

const ZERO_INPUT: PlayerInput = { tick: 0, mx: 0, my: 0, dash: false };

// Pure sim step. Returns a NEW WorldState. Inputs are matched to players by id;
// missing inputs default to zero-input (player keeps moving with prior velocity? No —
// idle. Standard for FPS-style games where movement is direct, not impulse-based).
export function simulate(
  state: WorldState,
  inputs: ReadonlyMap<string, PlayerInput>,
  dt: number,
): WorldState {
  const worldW = gridPixelWidth(state.grid);
  const worldH = gridPixelHeight(state.grid);

  const nextPlayers: Player[] = state.players.map((p) => {
    const input = inputs.get(p.id) ?? ZERO_INPUT;
    return stepPlayer(p, input, dt, worldW, worldH);
  });

  return {
    tick: state.tick + 1,
    grid: state.grid,
    players: nextPlayers,
    rngState: state.rngState,
  };
}

function stepPlayer(p: Player, input: PlayerInput, dt: number, worldW: number, worldH: number): Player {
  let dashTimer = p.dashTimer;
  let dashCooldown = Math.max(0, p.dashCooldown - dt);

  // Normalize input vector
  const magnitudeSq = input.mx * input.mx + input.my * input.my;
  let nx = 0;
  let ny = 0;
  if (magnitudeSq > 1e-6) {
    const mag = Math.min(1, Math.sqrt(magnitudeSq));
    const inv = mag > 0 ? mag / Math.sqrt(magnitudeSq) : 0;
    nx = input.mx * inv;
    ny = input.my * inv;
  }

  let vx: number;
  let vy: number;
  let facing = p.facing;

  // Update facing from input if there is any
  if (magnitudeSq > 1e-6) {
    facing = Math.atan2(ny, nx);
  }

  // Dash trigger: only if grounded (not already dashing) and off cooldown
  if (input.dash && dashTimer <= 0 && dashCooldown <= 0) {
    dashTimer = PLAYER_DASH_DURATION_S;
    dashCooldown = PLAYER_DASH_COOLDOWN_S;
    // Lock dash velocity at trigger time. If no input direction, use facing.
    let dx = nx;
    let dy = ny;
    if (dx === 0 && dy === 0) {
      dx = Math.cos(facing);
      dy = Math.sin(facing);
    }
    vx = dx * PLAYER_DASH_SPEED;
    vy = dy * PLAYER_DASH_SPEED;
  } else if (dashTimer > 0) {
    // Continue dash with frozen velocity from p (we stored it in vx/vy last tick)
    vx = p.vx;
    vy = p.vy;
    dashTimer = Math.max(0, dashTimer - dt);
  } else {
    vx = nx * PLAYER_MOVE_SPEED;
    vy = ny * PLAYER_MOVE_SPEED;
  }

  // Integrate position
  let x = p.x + vx * dt;
  let y = p.y + vy * dt;

  // Clamp to grid bounds (player radius keeps them on-screen).
  // Phase 0: all panels are LIVE so no panel-collision yet.
  const minX = PLAYER_RADIUS;
  const minY = PLAYER_RADIUS;
  const maxX = worldW - PLAYER_RADIUS;
  const maxY = worldH - PLAYER_RADIUS;
  if (x < minX) {
    x = minX;
    vx = 0;
  } else if (x > maxX) {
    x = maxX;
    vx = 0;
  }
  if (y < minY) {
    y = minY;
    vy = 0;
  } else if (y > maxY) {
    y = maxY;
    vy = 0;
  }

  return {
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    x,
    y,
    vx,
    vy,
    dashTimer,
    dashCooldown,
    facing,
  };
}

export function createPlayer(id: string, name: string, isBot: boolean, x: number, y: number): Player {
  return {
    id,
    name,
    isBot,
    x,
    y,
    vx: 0,
    vy: 0,
    dashTimer: 0,
    dashCooldown: 0,
    facing: 0,
  };
}

// Picks a sensible spawn point on a grid based on existing players.
export function pickSpawn(worldW: number, worldH: number, existing: Player[]): { x: number; y: number } {
  const corners = [
    { x: TILE_SIZE * 1.5, y: TILE_SIZE * 1.5 },
    { x: worldW - TILE_SIZE * 1.5, y: worldH - TILE_SIZE * 1.5 },
    { x: worldW - TILE_SIZE * 1.5, y: TILE_SIZE * 1.5 },
    { x: TILE_SIZE * 1.5, y: worldH - TILE_SIZE * 1.5 },
  ];
  const used = new Set<number>();
  for (const p of existing) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i]!;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) used.add(bestIdx);
  }
  for (let i = 0; i < corners.length; i++) {
    if (!used.has(i)) return corners[i]!;
  }
  return corners[0]!;
}
