import { PANEL_JUMP_COOLDOWN_S, PANEL_JUMP_TARGET_RANGE } from './constants.js';
import { indexOf, isPassage, type TileBuffers } from './tiles.js';
import type { GridDef, PlayerInput, PlayerState } from './types.js';

// Defensive clamp on the panel-jump cursor offset. The Input wire encoder
// already clamps to i8 ±range; this guards against in-process callers (tests,
// replay) and hostile clients that bypass the encoder.
export function clampPanelJumpOffset(v: number): number {
  const i = v | 0;
  if (i > PANEL_JUMP_TARGET_RANGE) return PANEL_JUMP_TARGET_RANGE;
  if (i < -PANEL_JUMP_TARGET_RANGE) return -PANEL_JUMP_TARGET_RANGE;
  return i;
}

// Buffered jump intent. C1.4 lets the player release Shift during cooldown
// and have the resulting jump fire as soon as the cooldown drains — instead
// of dropping the input. Capacity is exactly one; a second buffered release
// replaces the first (newest aim wins).
export interface BufferedJump {
  dx: number;
  dy: number;
}

// Try to teleport the player by (dx, dy) tiles. Returns the post-jump state
// on success or null if the target tile is invalid (off-grid or passage).
function fireJump(
  state: PlayerState,
  dx: number,
  dy: number,
  tiles: TileBuffers,
  grid: GridDef,
): PlayerState | null {
  if (dx === 0 && dy === 0) return null;
  const px = Math.floor(state.x / grid.panelSize);
  const py = Math.floor(state.y / grid.panelSize);
  const tx = px + dx;
  const ty = py + dy;
  if (tx < 0 || tx >= grid.cols || ty < 0 || ty >= grid.rows) return null;
  const idx = indexOf(grid.cols, tx, ty);
  if (isPassage(tiles, idx)) return null;
  return {
    ...state,
    x: tx * grid.panelSize + grid.panelSize / 2,
    y: ty * grid.panelSize + grid.panelSize / 2,
    panelJumpCooldownS: PANEL_JUMP_COOLDOWN_S,
  };
}

export interface PanelJumpResult {
  state: PlayerState;
  buffered: BufferedJump | null;
}

// Falling-edge panel-jump with single-slot input buffering. C1.4 behavior:
//   1. On the falling edge of jumpHeld:
//        - If cooldown is 0 → fire immediately.
//        - If cooldown is > 0 → stash the (dx, dy) in `buffered`.
//   2. Each tick, if cooldown has drained AND a buffered jump exists → fire
//      the buffered jump.
//
// Same code path runs server-side (Room) and client-side (PredictedWorld step
// + replay) so both sides converge on the same final position even when the
// player chains releases tighter than PANEL_JUMP_COOLDOWN_S.
//
// Invalid targets (off-grid, passage) silently drop without burning cooldown
// or filling the buffer, so the player can immediately re-aim.
export function tryPanelJump(
  state: PlayerState,
  input: PlayerInput,
  prevJumpHeld: boolean,
  buffered: BufferedJump | null,
  tiles: TileBuffers,
  grid: GridDef,
): PanelJumpResult {
  let curState = state;
  let curBuffered = buffered;

  // (1) Falling-edge handling.
  if (prevJumpHeld && !input.jumpHeld) {
    const dx = clampPanelJumpOffset(input.jumpCursorDx);
    const dy = clampPanelJumpOffset(input.jumpCursorDy);
    if (dx !== 0 || dy !== 0) {
      if (curState.panelJumpCooldownS > 0) {
        // Stash — newest aim wins, dropping any previous buffer.
        curBuffered = { dx, dy };
      } else {
        const fired = fireJump(curState, dx, dy, tiles, grid);
        if (fired) {
          curState = fired;
          // A successful fire clears any stale buffer (shouldn't be set
          // here since cooldown was 0, but be defensive).
          curBuffered = null;
        }
      }
    }
  }

  // (2) Drain-and-fire: cooldown just hit 0 (or is already 0) and we have a
  // buffered intent waiting. This is the case that fires "chained" jumps.
  if (curBuffered && curState.panelJumpCooldownS <= 0) {
    const fired = fireJump(curState, curBuffered.dx, curBuffered.dy, tiles, grid);
    if (fired) {
      curState = fired;
      curBuffered = null;
    } else {
      // Invalid target — drop the buffer rather than holding it forever.
      curBuffered = null;
    }
  }

  return { state: curState, buffered: curBuffered };
}
