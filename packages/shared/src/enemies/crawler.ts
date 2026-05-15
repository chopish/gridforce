import {
  CRAWLER_MOVE_SPEED,
  PANEL_ATTACK_TO_DAMAGE_S,
  PANEL_ATTACK_TO_BREAK_S,
} from '../constants.js';
import {
  PanelState,
  indexOf,
  type PanelStateValue,
} from '../panels.js';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';

export interface CrawlerStepContext {
  /** Mutable panel-state buffer. stepCrawler may mutate cells when a panel
   *  degrades. */
  panels: Uint8Array;
  /** Per-panel "seconds of attack accrued" — keyed by panel index. The step
   *  function bumps this for the panel being attacked and clears it once
   *  the panel transitions to the next state.
   *
   *  Multi-crawler stacking is intentional: two crawlers attacking the same
   *  panel share the same timer entry, so they degrade it ~2× as fast. Gang
   *  pressure feels right and matches the Smash-TV style of the doc. If a
   *  future enemy type needs isolated timers, key by (crawlerId, panelIdx). */
  attackTimers: Map<number, number>;
  /** Accumulator: incremented each time a crawler exits the world through a
   *  broken tile. The caller (Room) deducts city HP from this and resets. */
  cityHpDelta: number;
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
      return stepApproaching(c, dt, grid, ctx);
    case CrawlerAIState.ATTACKING:
      return stepAttacking(c, dt, grid, ctx);
    case CrawlerAIState.TRANSITING:
      return stepTransiting(c, dt, grid, ctx);
    default:
      return c;
  }
}

function stepApproaching(c: CrawlerState, dt: number, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  void ctx;
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

function stepAttacking(c: CrawlerState, dt: number, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  const idx = indexOf(grid.cols, c.targetCx, c.targetCy);
  const state = ctx.panels[idx] as PanelStateValue;
  if (state === PanelState.BROKEN) {
    // Another crawler already broke through; switch to transit.
    return { ...c, ai: CrawlerAIState.TRANSITING };
  }
  const accrued = (ctx.attackTimers.get(idx) ?? 0) + dt;
  const threshold = state === PanelState.LIVE
    ? PANEL_ATTACK_TO_DAMAGE_S
    : PANEL_ATTACK_TO_BREAK_S;
  if (accrued >= threshold) {
    const nextState: PanelStateValue = state === PanelState.LIVE ? PanelState.DAMAGED : PanelState.BROKEN;
    ctx.panels[idx] = nextState;
    ctx.attackTimers.set(idx, 0);
    if (nextState === PanelState.BROKEN) {
      return { ...c, ai: CrawlerAIState.TRANSITING };
    }
  } else {
    ctx.attackTimers.set(idx, accrued);
  }
  return c;
}

function stepTransiting(c: CrawlerState, dt: number, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  // Continue in the crawler's facing direction (set during APPROACHING).
  const step = CRAWLER_MOVE_SPEED * dt;
  const nx = c.x + Math.cos(c.facing) * step;
  const ny = c.y + Math.sin(c.facing) * step;
  const worldW = grid.cols * grid.panelSize;
  const worldH = grid.rows * grid.panelSize;
  if (nx < 0 || nx > worldW || ny < 0 || ny > worldH) {
    // Crawler has exited the world. Bump city HP delta and mark for removal
    // by zeroing hp; the caller (Room) reaps these between ticks.
    ctx.cityHpDelta += 1;
    return { ...c, x: nx, y: ny, hp: 0 };
  }
  return { ...c, x: nx, y: ny };
}
