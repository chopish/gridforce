import {
  SHOCK_BEAM_MAX_TILES,
  SHOCK_CHARGE_COOLDOWN_S,
  SHOCK_CHARGE_FULL_S,
  SHOCK_COOLDOWN_S,
} from './constants.js';
import { conductive, indexOf, type TileBuffers } from './tiles.js';
import type { GridDef, PlayerInput, PlayerState } from './types.js';

// One tile crossed by the shock beam. `conductive` is the tile's state at
// trace time — callers use it to decide whether to electrify the tile (live
// panel) or stop propagation (impact tile).
export interface ShockBeamHit {
  tx: number;
  ty: number;
  idx: number;
  conductive: boolean;
}

export interface ShockBeamTrace {
  hits: ShockBeamHit[];
  // Cooldown the firing player should adopt. Charged beams (held to >=50%)
  // pay a longer recharge than taps; matches Room's prior inline rule.
  cooldownS: number;
}

// Ray-march the shock beam from the player along input.facingRad, returning
// every tile the beam crosses (in order). Stops at SHOCK_BEAM_MAX_TILES
// conductive hits, at the first non-conductive impact tile, or at the grid
// edge. The first non-conductive tile is INCLUDED in `hits` (the beam still
// lands on it for damage / VFX), it just doesn't extend the propagation.
//
// Shared by server (Room.applyShockBeam — authoritative tile electrification
// + damage) and client (predicts tile electrification immediately so the
// player sees the panel light up without waiting for the next snapshot).
export function traceShockBeam(
  state: PlayerState,
  input: PlayerInput,
  tiles: TileBuffers,
  grid: GridDef,
): ShockBeamTrace {
  const { cols, rows, panelSize } = grid;
  const ratio = Math.min(1, state.shockHeldS / SHOCK_CHARGE_FULL_S);
  const beamTiles = Math.max(1, Math.ceil(ratio * SHOCK_BEAM_MAX_TILES));
  const px = state.x;
  const py = state.y;
  const dirX = Math.cos(input.facingRad);
  const dirY = Math.sin(input.facingRad);
  let lastTx = Math.floor(px / panelSize);
  let lastTy = Math.floor(py / panelSize);
  const hits: ShockBeamHit[] = [];
  let conductiveHits = 0;
  const step = panelSize / 8;
  const maxDist = beamTiles * panelSize + panelSize;
  for (let t = step; t <= maxDist && conductiveHits < beamTiles; t += step) {
    const sx = px + dirX * t;
    const sy = py + dirY * t;
    const tx = Math.floor(sx / panelSize);
    const ty = Math.floor(sy / panelSize);
    if (tx === lastTx && ty === lastTy) continue;
    lastTx = tx;
    lastTy = ty;
    if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) break;
    const idx = indexOf(cols, tx, ty);
    const isLive = conductive(tiles, idx);
    hits.push({ tx, ty, idx, conductive: isLive });
    if (!isLive) break;
    conductiveHits++;
  }
  const cooldownS = ratio >= 0.5 ? SHOCK_CHARGE_COOLDOWN_S : SHOCK_COOLDOWN_S;
  return { hits, cooldownS };
}
