import {
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
  // Tap and charged are intentionally separate models:
  //   - Tap (uncharged): exactly one conductive tile of reach.
  //   - Charged: no tile cap. Ray-marches until it hits an impact tile or
  //     the grid edge. SHOCK_BEAM_MAX_TILES does NOT apply to charged —
  //     the player explicitly opted in by holding for the full charge, and
  //     a charged beam's job is to clear every tile in the line.
  const conductiveCap = isCharged ? Infinity : 1;
  // Length budget. Tap reaches one full tile east of wherever the player
  // is standing — `panelSize * 1.5` is enough to cross the player's own
  // tile from the far edge AND reach into the adjacent tile (the conductive
  // cap of 1 stops it as soon as the first live cell is hit, so the extra
  // slack costs nothing in gameplay but avoids dropping the shot when the
  // player happens to be near the trailing edge of their tile). Charged is
  // bounded by the grid extent — impact-tile / grid-edge breaks it sooner.
  const maxDist = isCharged ? (cols + rows) * panelSize : panelSize * 1.5;
  const px = state.x;
  const py = state.y;
  const dirX = Math.cos(input.facingRad);
  const dirY = Math.sin(input.facingRad);
  let lastTx = Math.floor(px / panelSize);
  let lastTy = Math.floor(py / panelSize);
  const hits: ShockBeamHit[] = [];
  let conductiveHits = 0;
  const step = panelSize / 8;
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
