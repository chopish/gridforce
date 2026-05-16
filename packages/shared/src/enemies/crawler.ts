import { CRAWLER_MOVE_SPEED } from '../constants.js';
import type { TileBuffers } from '../tiles.js';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';

// Discrete tasks the priority-AI can assign to a crawler. The Room owns task
// selection (server-only, in CrawlerAi.ts); stepCrawler just executes whatever
// task it's handed. Keeping the executor pure makes it deterministic — a
// requirement for any future replay/client-prediction work.
export const CrawlerTaskKind = {
  CHASE_PLAYER: 0,
  ATTACK_TILE: 1,
} as const;
export type CrawlerTaskKindValue = (typeof CrawlerTaskKind)[keyof typeof CrawlerTaskKind];

export type CrawlerTask =
  | { kind: typeof CrawlerTaskKind.CHASE_PLAYER; targetX: number; targetY: number }
  | { kind: typeof CrawlerTaskKind.ATTACK_TILE; targetCx: number; targetCy: number };

export interface CrawlerStepContext {
  tiles: TileBuffers;
}

function clampToGrid(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Pure executor: applies one tick of motion based on the supplied task.
// CHASE walks straight toward (task.targetX, task.targetY) at full speed (no
// on-panel slowdown — the bug is not "damaging tiles it runs over", per the
// C1.4 design rule). ATTACK_TILE freezes the bug on its current tile so the
// Room's weight-integrity loop hits the right cell.
export function stepCrawler(
  c: CrawlerState,
  task: CrawlerTask,
  dt: number,
  grid: GridDef,
  _ctx: CrawlerStepContext,
): CrawlerState {
  if (task.kind === CrawlerTaskKind.ATTACK_TILE) {
    return {
      ...c,
      ai: CrawlerAIState.ATTACKING,
      targetCx: clampToGrid(task.targetCx, 0, grid.cols - 1),
      targetCy: clampToGrid(task.targetCy, 0, grid.rows - 1),
    };
  }

  // CHASE.
  const dx = task.targetX - c.x;
  const dy = task.targetY - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    // Bug is on the target — stop, mark ATTACKING so the tile under the
    // player takes weight. (Player damage requires PlayerState.hp on the
    // wire — that's a future change.)
    const tcx = clampToGrid(Math.floor(c.x / grid.panelSize), 0, grid.cols - 1);
    const tcy = clampToGrid(Math.floor(c.y / grid.panelSize), 0, grid.rows - 1);
    return { ...c, ai: CrawlerAIState.ATTACKING, targetCx: tcx, targetCy: tcy };
  }
  const step = CRAWLER_MOVE_SPEED * dt;
  const move = Math.min(step, dist);
  const nx = c.x + (dx / dist) * move;
  const ny = c.y + (dy / dist) * move;
  const ntcx = clampToGrid(Math.floor(nx / grid.panelSize), 0, grid.cols - 1);
  const ntcy = clampToGrid(Math.floor(ny / grid.panelSize), 0, grid.rows - 1);
  return {
    ...c,
    ai: CrawlerAIState.APPROACHING,
    x: nx,
    y: ny,
    facing: Math.atan2(dy, dx),
    targetCx: ntcx,
    targetCy: ntcy,
  };
}
