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

// Falling-edge panel-jump. Returns the state with x/y/cooldown advanced if the
// jump fired, or `state` unchanged otherwise. Used by both server (Room) and
// client (PredictedWorld) so the same code path drives prediction, replay, and
// authoritative resolution.
export function tryPanelJump(
  state: PlayerState,
  input: PlayerInput,
  prevJumpHeld: boolean,
  tiles: TileBuffers,
  grid: GridDef,
): PlayerState {
  // Trigger on the falling edge of jumpHeld (Shift release).
  if (!prevJumpHeld || input.jumpHeld) return state;
  if (state.panelJumpCooldownS > 0) return state;
  const dx = clampPanelJumpOffset(input.jumpCursorDx);
  const dy = clampPanelJumpOffset(input.jumpCursorDy);
  if (dx === 0 && dy === 0) return state;
  const px = Math.floor(state.x / grid.panelSize);
  const py = Math.floor(state.y / grid.panelSize);
  const tx = px + dx;
  const ty = py + dy;
  if (tx < 0 || tx >= grid.cols || ty < 0 || ty >= grid.rows) return state;
  const idx = indexOf(grid.cols, tx, ty);
  // Passage = both L0 and L1 destroyed — no floor to land on. Cancel without
  // burning cooldown so the player can immediately re-aim.
  if (isPassage(tiles, idx)) return state;
  return {
    ...state,
    x: tx * grid.panelSize + grid.panelSize / 2,
    y: ty * grid.panelSize + grid.panelSize / 2,
    panelJumpCooldownS: PANEL_JUMP_COOLDOWN_S,
  };
}
