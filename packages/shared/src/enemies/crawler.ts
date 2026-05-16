import { CRAWLER_MOVE_SPEED } from '../constants.js';
import { indexOf, type TileBuffers } from '../tiles.js';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
  type PlayerState,
} from '../types.js';

// Context passed to the per-tick crawler step. The Room owns this and
// re-uses it across all crawlers in a tick. C1.2 added `players` so bugs
// can target the nearest pilot instead of a fixed edge tile.
export interface CrawlerStepContext {
  tiles: TileBuffers;
  players: Iterable<PlayerState>;
}

// Bugs move slower while crossing an intact panel — the panel resists the
// crush. This factor (0..1) is multiplied with CRAWLER_MOVE_SPEED for any
// tick the bug is on a tile with l1 > 0. Off-grid and passage tiles use
// full speed.
const ON_PANEL_SPEED_FACTOR = 0.5;

function nearestPlayer(c: CrawlerState, players: Iterable<PlayerState>): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD2 = Infinity;
  for (const p of players) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

function clampToGrid(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// C1.3 chase AI: bugs always walk toward the nearest pilot. They damage
// whatever tile they're currently on (via the Room's weight-integrity loop,
// which now weights both APPROACHING and ATTACKING bugs). The bug is
// ATTACKING when it's standing still (e.g. blocked, no target, or close to
// player) and APPROACHING when it's making progress — purely for the
// client-side attack pulse VFX; both states contribute weight identically.
export function stepCrawler(
  c: CrawlerState,
  dt: number,
  grid: GridDef,
  ctx: CrawlerStepContext,
): CrawlerState {
  const tcx = Math.floor(c.x / grid.panelSize);
  const tcy = Math.floor(c.y / grid.panelSize);

  // Used by the Room's weight-integrity loop. Clamp to in-bounds so
  // off-grid bugs (just-spawned, just-walked-off) don't damage anything.
  const wTcx = clampToGrid(tcx, 0, grid.cols - 1);
  const wTcy = clampToGrid(tcy, 0, grid.rows - 1);
  // Only contribute weight when the bug is actually inside the playfield —
  // otherwise the Room will skip it via its own bounds check.
  const inBounds = tcx >= 0 && tcx < grid.cols && tcy >= 0 && tcy < grid.rows;

  const target = nearestPlayer(c, ctx.players);
  if (!target) {
    return { ...c, ai: CrawlerAIState.ATTACKING, targetCx: wTcx, targetCy: wTcy };
  }

  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    // On top of the pilot — stop and ATTACK (the tile under their feet).
    return { ...c, ai: CrawlerAIState.ATTACKING, targetCx: wTcx, targetCy: wTcy };
  }

  // Slow crawl on intact panels. The bug is grinding through the layer as
  // it moves. Off-grid (out of bounds) uses full speed so bugs enter the
  // map quickly after spawn.
  let speed = CRAWLER_MOVE_SPEED;
  if (inBounds) {
    const idx = indexOf(grid.cols, tcx, tcy);
    if (ctx.tiles.l1Hp[idx]! > 0) speed *= ON_PANEL_SPEED_FACTOR;
  }
  const step = speed * dt;
  const move = Math.min(step, dist);
  const nx = c.x + (dx / dist) * move;
  const ny = c.y + (dy / dist) * move;
  // targetCx/Cy follow the bug as it moves so weight always lands on the
  // tile the bug is actually on at end-of-tick.
  const ntcx = Math.floor(nx / grid.panelSize);
  const ntcy = Math.floor(ny / grid.panelSize);
  const nWtcx = clampToGrid(ntcx, 0, grid.cols - 1);
  const nWtcy = clampToGrid(ntcy, 0, grid.rows - 1);
  return {
    ...c,
    ai: CrawlerAIState.APPROACHING,
    x: nx,
    y: ny,
    facing: Math.atan2(dy, dx),
    targetCx: nWtcx,
    targetCy: nWtcy,
  };
}
