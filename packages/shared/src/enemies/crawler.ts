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

// Within this distance (px) of a tile centre the crawler is "well inside"
// the tile and may flip to ATTACKING. Tightened in C1.2 from ½-panel so
// bugs visibly burrow into the tile before damaging it. Effective only
// when an L1 panel is intact at the crawler's tile; otherwise the crawler
// keeps walking toward its target.
const ATTACK_INSIDE_PX = 12;

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

export function stepCrawler(
  c: CrawlerState,
  dt: number,
  grid: GridDef,
  ctx: CrawlerStepContext,
): CrawlerState {
  // C1.2: every tick, retarget to nearest pilot. The bug walks toward the
  // player; when it stops on a tile that still has an L1 panel, it dwells
  // there to damage that tile (Room aggregates weight). With no players in
  // the room (paused / lobby), the bug just stops in place.
  const tcx = Math.floor(c.x / grid.panelSize);
  const tcy = Math.floor(c.y / grid.panelSize);
  const target = nearestPlayer(c, ctx.players);
  if (!target) {
    // No pilots in the room → idle in place. Keep targetCx/Cy in sync with
    // the bug's current tile so the Room's integrity loop weights the right
    // cell (the tile the bug is standing on).
    if (c.ai === CrawlerAIState.ATTACKING && c.targetCx === tcx && c.targetCy === tcy) return c;
    return { ...c, ai: CrawlerAIState.ATTACKING, targetCx: tcx, targetCy: tcy };
  }
  const idx = indexOf(grid.cols, tcx, tcy);
  const l1Alive = ctx.tiles.l1Hp[idx]! > 0;
  // Centre of the bug's CURRENT tile (used both for "am I inside it?" and
  // for stepping toward player while staying mostly on-grid).
  const tileCx = tcx * grid.panelSize + grid.panelSize / 2;
  const tileCy = tcy * grid.panelSize + grid.panelSize / 2;
  const distToCentre = Math.hypot(tileCx - c.x, tileCy - c.y);

  // If the bug is well inside a tile with an intact panel, ATTACK that tile.
  if (l1Alive && distToCentre <= ATTACK_INSIDE_PX) {
    return c.ai === CrawlerAIState.ATTACKING
      ? c
      : { ...c, ai: CrawlerAIState.ATTACKING, targetCx: tcx, targetCy: tcy };
  }

  // Otherwise APPROACH. If the current tile still has a panel, walk to its
  // centre (so the bug doesn't skim past tiles without damaging them); once
  // the tile is destroyed (passage), walk directly toward the player.
  let dx: number;
  let dy: number;
  if (l1Alive) {
    dx = tileCx - c.x;
    dy = tileCy - c.y;
  } else {
    dx = target.x - c.x;
    dy = target.y - c.y;
  }
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-3) {
    return c.ai === CrawlerAIState.APPROACHING
      ? c
      : { ...c, ai: CrawlerAIState.APPROACHING, targetCx: tcx, targetCy: tcy };
  }
  const step = CRAWLER_MOVE_SPEED * dt;
  const move = Math.min(step, dist);
  return {
    ...c,
    ai: CrawlerAIState.APPROACHING,
    x: c.x + (dx / dist) * move,
    y: c.y + (dy / dist) * move,
    facing: Math.atan2(dy, dx),
    targetCx: tcx,
    targetCy: tcy,
  };
}
