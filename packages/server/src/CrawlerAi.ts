import {
  CrawlerTaskKind,
  indexOf,
  type CrawlerState,
  type CrawlerTask,
  type GridDef,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

// Mite baseline priority profile, ported from the original GridForce concept
// doc. Future enemy classes get their own profile so the same machinery can
// drive different behavioural tendencies. The "attention" component is the
// per-scan penalty applied to whichever task the bug is currently doing — it
// drives the boredom-driven re-target behaviour.
const MITE_PROFILE = {
  player: 100,
  panel: 20,
  dome: 20,
  attentionPerScan: 10,
};

// Re-evaluate every half second. Faster than the 1s in the original design,
// because at 0.5s the bugs visibly switch task mid-fight which is what
// "feels alive" in playtest. Stochastic noise (`noise()`) keeps a group from
// switching in lockstep.
const TASK_REEVAL_INTERVAL_S = 0.5;

// On a task switch, lock the new task in for this long. Without this the bug
// flaps between tasks each scan because the freshly-reset attention lets the
// other task win on the very next pass. 1.5s is enough to be visually
// committed; 0.5s commitments still felt jittery in feel-tests.
const COMMIT_AFTER_SWITCH_S = 1.5;

// Stochastic multiplier on each option's base score. Identical mites in the
// same situation should *usually* agree but occasionally disagree — that's
// the only thing that breaks lockstep swarms.
function noise(): number {
  return 0.85 + Math.random() * 0.3; // ±15%
}

function nearestPlayer(c: CrawlerState, players: ReadonlyArray<PlayerState>): PlayerState | null {
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

interface CrawlerAi {
  task: CrawlerTask;
  attentionPenalty: number;
  reevalInS: number;
  commitInS: number;
}

function defaultTask(): CrawlerTask {
  return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: 0, targetY: 0 };
}

// Per-room priority-AI manager. One instance per Room; one entry per live
// crawler. The Room calls `decide(...)` each tick to get the task to feed
// into stepCrawler.
export class CrawlerAiManager {
  private states = new Map<number, CrawlerAi>();

  decide(
    c: CrawlerState,
    dt: number,
    players: ReadonlyArray<PlayerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): CrawlerTask {
    let ai = this.states.get(c.id);
    if (!ai) {
      ai = { task: defaultTask(), attentionPenalty: 0, reevalInS: 0, commitInS: 0 };
      this.states.set(c.id, ai);
    }
    ai.commitInS = Math.max(0, ai.commitInS - dt);
    ai.reevalInS -= dt;

    if (ai.commitInS <= 0 && ai.reevalInS <= 0) {
      const newTask = this.score(c, ai, players, tiles, grid);
      if (newTask.kind !== ai.task.kind) {
        ai.task = newTask;
        ai.attentionPenalty = 0;
        ai.commitInS = COMMIT_AFTER_SWITCH_S;
      } else {
        // Same kind — refresh target details (player position may have
        // moved) and accumulate boredom.
        ai.task = newTask;
        ai.attentionPenalty += MITE_PROFILE.attentionPerScan;
      }
      ai.reevalInS = TASK_REEVAL_INTERVAL_S;
    } else if (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER) {
      // Inside the commitment window we still re-aim a chase at the player's
      // current position — the commitment is on the task KIND, not the
      // specific target coordinates. Otherwise a committed chase points at
      // wherever the pilot was when we last scanned.
      const t = nearestPlayer(c, players);
      if (t) ai.task = { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: t.x, targetY: t.y };
    }
    return ai.task;
  }

  // Score each candidate task and pick the winner.
  private score(
    c: CrawlerState,
    ai: CrawlerAi,
    players: ReadonlyArray<PlayerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): CrawlerTask {
    const target = nearestPlayer(c, players);
    const tcx = Math.floor(c.x / grid.panelSize);
    const tcy = Math.floor(c.y / grid.panelSize);
    const inBounds = tcx >= 0 && tcx < grid.cols && tcy >= 0 && tcy < grid.rows;

    let chaseScore = target ? MITE_PROFILE.player * noise() : -Infinity;
    let panelScore = -Infinity;
    let domeScore = -Infinity;
    if (inBounds) {
      const idx = indexOf(grid.cols, tcx, tcy);
      if (tiles.l1Hp[idx]! > 0) {
        panelScore = MITE_PROFILE.panel * noise();
      } else if (tiles.l0Hp[idx]! > 0) {
        domeScore = MITE_PROFILE.dome * noise();
      }
    }

    // Apply attention penalty to whichever task is currently active.
    if (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER) {
      chaseScore -= ai.attentionPenalty;
    } else if (ai.task.kind === CrawlerTaskKind.ATTACK_TILE) {
      panelScore -= ai.attentionPenalty;
      domeScore -= ai.attentionPenalty;
    }

    if (chaseScore >= panelScore && chaseScore >= domeScore && target) {
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: target.x, targetY: target.y };
    }
    // Either panel or dome wins — both reduce to ATTACK_TILE on the bug's
    // current tile. (The scoring distinguishes them so a "no L1 left but L0
    // intact" tile still attracts attention; the action is the same.)
    return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: tcx, targetCy: tcy };
  }

  remove(id: number): void {
    this.states.delete(id);
  }

  clear(): void {
    this.states.clear();
  }
}
