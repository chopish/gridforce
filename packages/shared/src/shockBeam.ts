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
// every tile the beam crosses (in order). A tap (ratio<0.5) electrifies only
// the FIRST conductive tile in path. A charged beam (ratio>=0.5) electrifies
// every conductive tile up to its length budget. Either way the beam stops at
// the first non-conductive impact tile (still INCLUDED in `hits` for
// damage / VFX) or at the grid edge.
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
  const isCharged = ratio >= 0.5;
  // Length budget. Tap = 1 tile cell of reach (just enough to land on the
  // adjacent tile); charged scales with hold time up to SHOCK_BEAM_MAX_TILES.
  const beamTiles = isCharged ? Math.max(1, Math.ceil(ratio * SHOCK_BEAM_MAX_TILES)) : 1;
  // Tap = activate only the first conductive hit. Charged = activate every
  // conductive tile within its length budget.
  const conductiveCap = isCharged ? beamTiles : 1;
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
  for (let t = step; t <= maxDist && conductiveHits < conductiveCap; t += step) {
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
  const cooldownS = isCharged ? SHOCK_CHARGE_COOLDOWN_S : SHOCK_COOLDOWN_S;
  return { hits, cooldownS };
}
