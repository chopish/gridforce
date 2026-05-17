import { CRAWLER_MOVE_SPEED } from '../constants.js';
import type { TileBuffers } from '../tiles.js';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';
import { MITE_PROFILE } from './profiles.js';

// Discrete tasks the priority-AI can assign to a crawler. The Room owns task
// selection (server-only, in CrawlerAi.ts); stepCrawler just executes whatever
// task it's handed. Keeping the executor pure makes it deterministic — a
// requirement for any future replay/client-prediction work.
export const CrawlerTaskKind = {
  CHASE_PLAYER: 0,
  ATTACK_TILE: 1,
  // T13: walk toward a damaged tile in range. On arrival, the executor
  // promotes the bug to ATTACKING so the Room's weight-integrity loop
  // picks up the new attacker.
  SEEK_TILE: 2,
  // T14: wander toward a random nearby target at reduced speed. Emits
  // CrawlerAIState.SEARCHING. Paired with the SEARCH task's widened
  // detection radius (searchRadiusMult) — slower legs, sharper eyes.
  SEARCH: 3,
} as const;
export type CrawlerTaskKindValue = (typeof CrawlerTaskKind)[keyof typeof CrawlerTaskKind];

export type CrawlerTask =
  | { kind: typeof CrawlerTaskKind.CHASE_PLAYER; targetX: number; targetY: number }
  | { kind: typeof CrawlerTaskKind.ATTACK_TILE; targetCx: number; targetCy: number }
  | { kind: typeof CrawlerTaskKind.SEEK_TILE; targetCx: number; targetCy: number }
  | { kind: typeof CrawlerTaskKind.SEARCH; targetX: number; targetY: number };

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

  // SEEK_TILE — walk toward the chosen damaged tile. When the bug arrives
  // within a quarter-panel of the tile centre, promote to ATTACKING so the
  // Room's integrity loop sees a new attacker on this cell. The seed/pick
  // of which tile to chase lives in CrawlerAi (findBestSeekTile); the
  // executor only knows "walk to (targetCx, targetCy), then attack".
  if (task.kind === CrawlerTaskKind.SEEK_TILE) {
    const tx = (task.targetCx + 0.5) * grid.panelSize;
    const ty = (task.targetCy + 0.5) * grid.panelSize;
    const ddx = tx - c.x;
    const ddy = ty - c.y;
    const ddist = Math.hypot(ddx, ddy);
    if (ddist < grid.panelSize * 0.25) {
      // Arrived — flip to ATTACKING so weight-integrity hits this tile.
      return {
        ...c,
        ai: CrawlerAIState.ATTACKING,
        targetCx: clampToGrid(task.targetCx, 0, grid.cols - 1),
        targetCy: clampToGrid(task.targetCy, 0, grid.rows - 1),
      };
    }
    const seekStep = CRAWLER_MOVE_SPEED * dt;
    const seekMove = Math.min(seekStep, ddist);
    return {
      ...c,
      ai: CrawlerAIState.APPROACHING,
      x: c.x + (ddx / ddist) * seekMove,
      y: c.y + (ddy / ddist) * seekMove,
      facing: Math.atan2(ddy, ddx),
      targetCx: clampToGrid(task.targetCx, 0, grid.cols - 1),
      targetCy: clampToGrid(task.targetCy, 0, grid.rows - 1),
    };
  }

  // SEARCH — wander toward a random target at reduced speed. Manager
  // re-rolls the next destination via the standard reeval cadence; on
  // arrival the executor just holds (with state=SEARCHING) until then.
  if (task.kind === CrawlerTaskKind.SEARCH) {
    const dx = task.targetX - c.x;
    const dy = task.targetY - c.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 4) {
      // Arrived — manager will reroll on next decide.
      return { ...c, ai: CrawlerAIState.SEARCHING };
    }
    const step = CRAWLER_MOVE_SPEED * dt * 0.7; // slower than chase
    const move = Math.min(step, dist);
    return {
      ...c,
      ai: CrawlerAIState.SEARCHING,
      x: c.x + (dx / dist) * move,
      y: c.y + (dy / dist) * move,
      facing: Math.atan2(dy, dx),
    };
  }

  // CHASE.
  const dx = task.targetX - c.x;
  const dy = task.targetY - c.y;
  const dist = Math.hypot(dx, dy);

  // Arrival at melee gap → WIND_UP. The executor doesn't know which
  // EnemyProfile the bug belongs to (server-side AI manager owns that),
  // so we read MITE_PROFILE directly for v1 — mite is the only enemy.
  // When a second profile lands, extend CrawlerStepContext with `profile`
  // and read from there instead.
  const meleeGap = MITE_PROFILE.meleeGapPx;
  if (dist < meleeGap) {
    return {
      ...c,
      ai: CrawlerAIState.WIND_UP,
      facing: Math.atan2(dy, dx),
      windUpInS: MITE_PROFILE.windUpDurS,
      // NOTE: deliberately do NOT mutate targetCx/Cy to the pilot's tile.
      // Weight integrity (Room.ts) only damages tiles when ai === ATTACKING.
      // Leaving targetCx/Cy alone keeps the bug "facing the pilot" without
      // pretending it's chewing the tile under the pilot's feet.
    };
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
