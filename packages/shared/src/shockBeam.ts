import {
  SHOCK_BEAM_MAX_TILES,
  SHOCK_BEAM_MIN_CHARGED_TILES,
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
  // Effective beam length in pixels, from player position to where the beam
  // stops (last hit's far edge OR maxDist if no impact). Used by damage
  // callers to bound the bug-intersection sweep — bugs past beamEndPx don't
  // get hit even if they're geometrically on the ray's infinite extension.
  beamEndPx: number;
  // Beam direction (unit vector). Pre-computed so damage callers don't have
  // to re-derive from facingRad.
  dirX: number;
  dirY: number;
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
  //   - Charged: range scales with hold time from MIN to MAX tiles.
  //     Within that range every conductive cell the ray crosses gets
  //     electrified (no per-tile cap), bounded only by impact tile,
  //     grid edge, or the length budget.
  const conductiveCap = isCharged ? Infinity : 1;
  // Charged ratio is in [0.5, 1.0]; remap to [0, 1] so a barely-charged
  // shot still reaches the MIN range and a full-charge reaches MAX.
  const chargedT = Math.max(0, (ratio - 0.5) * 2);
  const chargedTiles =
    SHOCK_BEAM_MIN_CHARGED_TILES +
    Math.round(chargedT * (SHOCK_BEAM_MAX_TILES - SHOCK_BEAM_MIN_CHARGED_TILES));
  // Length budget. Tap = `panelSize * 1.5` (enough slack to land the
  // adjacent tile even when the player is at the trailing edge of their
  // own tile; the cap of 1 stops propagation as soon as the first live
  // cell is hit). Charged = `chargedTiles * panelSize` of straight-line
  // reach.
  const maxDist = isCharged ? chargedTiles * panelSize : panelSize * 1.5;
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
  // beamEndPx = the geometric reach of the beam line, used by damage callers
  // to bound crawler-hitbox intersection. Decoupled from `hits` so bug
  // damage works the same whether the beam crossed live tiles, passages, or
  // empty space — the player-perceived "shock line" extends to maxDist
  // regardless of tile state.
  const beamEndPx = maxDist;
  return { hits, cooldownS, beamEndPx, dirX, dirY };
}

// Crawler hitbox vs. beam-line intersection. Returns true if a circle at
// (cx, cy) with radius `cr` intersects the line segment starting at
// (bx, by) in direction (dirX, dirY) for `beamEndPx` pixels, with `halfWidth`
// of perpendicular tolerance (so the beam reads as a thin rectangle, not a
// hairline). Used by Room.applyShockBeam to damage exactly the bugs the
// beam actually crosses, instead of every bug whose centre happens to lie
// on a hit tile (which was the old "flood the tile" shortcut).
export function crawlerHitByBeam(
  cx: number,
  cy: number,
  cr: number,
  bx: number,
  by: number,
  dirX: number,
  dirY: number,
  beamEndPx: number,
  halfWidth: number,
): boolean {
  const relX = cx - bx;
  const relY = cy - by;
  // Project onto beam axis. Negative = behind the player; greater than
  // beamEndPx = past the beam's reach. Clamp the bug-radius tolerance into
  // those bounds so a bug straddling the beam's start or end still counts.
  const along = relX * dirX + relY * dirY;
  if (along < -cr || along > beamEndPx + cr) return false;
  // Perpendicular distance (cross-product magnitude in 2D).
  const perp = Math.abs(relX * dirY - relY * dirX);
  return perp <= cr + halfWidth;
}
