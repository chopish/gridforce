import { CRAWLER_MOVE_SPEED } from '../constants.js';
import { indexOf, isPassage, type TileBuffers } from '../tiles.js';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';

// Context passed to the per-tick crawler step. The Room owns this and
// re-uses it across all crawlers in a tick.
//
// Note: the previous deterministic-attack-timer fields (`panels`,
// `attackTimers`, `cityHpDelta`) were retired in C1 in favour of the
// weight-driven integrity model. The room aggregates bug weights per
// tile after this step loop runs and applies damage to the topmost
// layer at each affected tile.
export interface CrawlerStepContext {
  tiles: TileBuffers;
}

const HALF_PANEL_FACTOR = 0.5;

export function stepCrawler(
  c: CrawlerState,
  dt: number,
  grid: GridDef,
  ctx: CrawlerStepContext,
): CrawlerState {
  switch (c.ai) {
    case CrawlerAIState.APPROACHING:
      return stepApproaching(c, dt, grid);
    case CrawlerAIState.ATTACKING:
      return stepAttacking(c, grid, ctx);
    case CrawlerAIState.TRANSITING:
      return stepTransiting(c, dt, grid);
    default:
      return c;
  }
}

function stepApproaching(c: CrawlerState, dt: number, grid: GridDef): CrawlerState {
  const tx = c.targetCx * grid.panelSize + grid.panelSize / 2;
  const ty = c.targetCy * grid.panelSize + grid.panelSize / 2;
  const dx = tx - c.x;
  const dy = ty - c.y;
  const dist = Math.hypot(dx, dy);
  // Once within half a panel of the target, transition to ATTACKING.
  if (dist <= grid.panelSize * HALF_PANEL_FACTOR) {
    return { ...c, ai: CrawlerAIState.ATTACKING };
  }
  const step = CRAWLER_MOVE_SPEED * dt;
  const move = Math.min(step, dist);
  return {
    ...c,
    x: c.x + (dx / dist) * move,
    y: c.y + (dy / dist) * move,
    facing: Math.atan2(dy, dx),
  };
}

function stepAttacking(c: CrawlerState, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  const idx = indexOf(grid.cols, c.targetCx, c.targetCy);
  if (isPassage(ctx.tiles, idx)) {
    // Target tile has been fully tunneled (L1 and L0 both destroyed) —
    // walk through. The Room reaps TRANSITING bugs that exit the map.
    return { ...c, ai: CrawlerAIState.TRANSITING };
  }
  // Crawler contributes weight to its target tile; damage is applied by the
  // Room's weight-integrity loop, not here.
  return c;
}

function stepTransiting(c: CrawlerState, dt: number, grid: GridDef): CrawlerState {
  // Continue in the crawler's facing direction (set during APPROACHING).
  const step = CRAWLER_MOVE_SPEED * dt;
  const nx = c.x + Math.cos(c.facing) * step;
  const ny = c.y + Math.sin(c.facing) * step;
  const worldW = grid.cols * grid.panelSize;
  const worldH = grid.rows * grid.panelSize;
  if (nx < 0 || nx > worldW || ny < 0 || ny > worldH) {
    // Crawler has exited the world. Set hp=0 so the Room reaps it; the
    // Room's loop will note the exit for city-HP bookkeeping (city HP
    // delta isn't tracked in C1 — that's a C3 concern).
    return { ...c, x: nx, y: ny, hp: 0 };
  }
  return { ...c, x: nx, y: ny };
}
