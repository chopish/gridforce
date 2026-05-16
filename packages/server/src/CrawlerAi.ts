import {
  CrawlerTaskKind,
  L0_DOME_MAX_HP,
  L1_PANEL_MAX_HP,
  indexOf,
  type CrawlerState,
  type CrawlerTask,
  type GridDef,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

// Mite baseline priority profile, refined for C1.5:
//
//   - `player` is the base score for chasing a pilot. Crowd boredom subtracts
//     `crowdPenaltyPerNearbyBug` × (#bugs within `crowdRadiusPx`) from this,
//     so a swarm gets more interested in breaking down structure the larger
//     it gets.
//   - Attack score is layer-aware. Healthy panels are an unattractive target
//     (`panelBase` is tiny); priority climbs as the panel takes damage, then
//     jumps to a much higher band when L1 is gone and the dome is exposed.
//     The "huge problem near a tunneled tile" scenario falls out of this:
//     dome-exposed tiles outscore most chase opportunities even before
//     crowd boredom kicks in.
//   - Attention is the per-scan boredom penalty on whichever task is
//     currently active. Drives the eventual task switch after a long
//     commitment.
const MITE_PROFILE = {
  player: 100,
  panelBase: 5,
  panelDamageScale: 15,
  domeBase: 25,
  domeDamageScale: 35,
  attentionPerScan: 10,
  crowdPenaltyPerNearbyBug: 5,
  crowdRadiusPx: 192, // 3 tiles
};

const TASK_REEVAL_INTERVAL_S = 0.5;
// Commit lock applied after switching INTO a chase task. Attacks use a
// different lock — they're committed-until-completion (the tile being
// destroyed) and ignore this constant.
const CHASE_COMMIT_S = 1.5;

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

function countNearbyBugs(
  self: CrawlerState,
  bugs: ReadonlyArray<CrawlerState>,
  radiusPx: number,
): number {
  const r2 = radiusPx * radiusPx;
  let n = 0;
  for (const b of bugs) {
    if (b.id === self.id) continue;
    const dx = b.x - self.x;
    const dy = b.y - self.y;
    if (dx * dx + dy * dy <= r2) n++;
  }
  return n;
}

interface CrawlerAi {
  task: CrawlerTask;
  attentionPenalty: number;
  reevalInS: number;
  // Time left in the chase-commit window. ATTACK tasks ignore this — they
  // hold until the target tile is destroyed (see "lockedOnAttack" below).
  chaseCommitInS: number;
}

function defaultTask(): CrawlerTask {
  return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: 0, targetY: 0 };
}

export class CrawlerAiManager {
  private states = new Map<number, CrawlerAi>();

  decide(
    c: CrawlerState,
    dt: number,
    players: ReadonlyArray<PlayerState>,
    bugs: ReadonlyArray<CrawlerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): CrawlerTask {
    let ai = this.states.get(c.id);
    if (!ai) {
      ai = { task: defaultTask(), attentionPenalty: 0, reevalInS: 0, chaseCommitInS: 0 };
      this.states.set(c.id, ai);
    }
    ai.chaseCommitInS = Math.max(0, ai.chaseCommitInS - dt);
    ai.reevalInS -= dt;

    // Commit-until-completion for ATTACK tasks. The bug holds the bite until
    // the target tile is fully tunneled (passage). Re-evaluation is
    // suppressed for the duration of the attack — attention is the boredom
    // counter that influences what they do NEXT, once they're free.
    if (ai.task.kind === CrawlerTaskKind.ATTACK_TILE) {
      const tcx = ai.task.targetCx;
      const tcy = ai.task.targetCy;
      const inBounds = tcx >= 0 && tcx < grid.cols && tcy >= 0 && tcy < grid.rows;
      if (inBounds) {
        const idx = indexOf(grid.cols, tcx, tcy);
        const stillAttackable = tiles.l1Hp[idx]! > 0 || tiles.l0Hp[idx]! > 0;
        if (stillAttackable) {
          if (ai.reevalInS <= 0) {
            ai.attentionPenalty += MITE_PROFILE.attentionPerScan;
            ai.reevalInS = TASK_REEVAL_INTERVAL_S;
          }
          return ai.task;
        }
        // Tile is dead — task complete. Fall through to re-eval immediately;
        // the accumulated attention biases the next pick away from
        // attacking again, which is the intended "go chase or look around"
        // post-kill behaviour.
      }
    }

    // Chase commitment — short lock so the bug doesn't flap to a different
    // task every single scan.
    if (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER && ai.chaseCommitInS > 0 && ai.reevalInS > 0) {
      const t = nearestPlayer(c, players);
      if (t) ai.task = { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: t.x, targetY: t.y };
      return ai.task;
    }

    // Re-evaluate.
    if (ai.reevalInS > 0) {
      if (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER) {
        const t = nearestPlayer(c, players);
        if (t) ai.task = { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: t.x, targetY: t.y };
      }
      return ai.task;
    }

    const newTask = this.score(c, ai, players, bugs, tiles, grid);
    const sameKind = newTask.kind === ai.task.kind;
    const sameTarget = sameKind && newTask.kind === CrawlerTaskKind.ATTACK_TILE
      && ai.task.kind === CrawlerTaskKind.ATTACK_TILE
      && newTask.targetCx === ai.task.targetCx
      && newTask.targetCy === ai.task.targetCy;
    if (!sameKind || (newTask.kind === CrawlerTaskKind.ATTACK_TILE && !sameTarget)) {
      ai.task = newTask;
      ai.attentionPenalty = 0;
      ai.chaseCommitInS = newTask.kind === CrawlerTaskKind.CHASE_PLAYER ? CHASE_COMMIT_S : 0;
    } else {
      ai.task = newTask;
      ai.attentionPenalty += MITE_PROFILE.attentionPerScan;
    }
    ai.reevalInS = TASK_REEVAL_INTERVAL_S;
    return ai.task;
  }

  private score(
    c: CrawlerState,
    ai: CrawlerAi,
    players: ReadonlyArray<PlayerState>,
    bugs: ReadonlyArray<CrawlerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): CrawlerTask {
    const target = nearestPlayer(c, players);
    const tcx = Math.floor(c.x / grid.panelSize);
    const tcy = Math.floor(c.y / grid.panelSize);
    const inBounds = tcx >= 0 && tcx < grid.cols && tcy >= 0 && tcy < grid.rows;

    // Chase — base 100, reduced by crowd boredom (bugs within radius).
    let chaseScore = -Infinity;
    if (target) {
      const crowd = countNearbyBugs(c, bugs, MITE_PROFILE.crowdRadiusPx);
      chaseScore = MITE_PROFILE.player - crowd * MITE_PROFILE.crowdPenaltyPerNearbyBug;
    }

    // Attack the topmost surviving layer on the bug's current tile. Layer
    // preference is baked into the base+scale numbers: panels start
    // unappealing and climb a little as they take damage; dome starts
    // appealing and climbs aggressively as it cracks.
    let attackScore = -Infinity;
    if (inBounds) {
      const idx = indexOf(grid.cols, tcx, tcy);
      const l1 = tiles.l1Hp[idx]!;
      const l0 = tiles.l0Hp[idx]!;
      if (l1 > 0) {
        attackScore = MITE_PROFILE.panelBase + MITE_PROFILE.panelDamageScale * (1 - l1 / L1_PANEL_MAX_HP);
      } else if (l0 > 0) {
        attackScore = MITE_PROFILE.domeBase + MITE_PROFILE.domeDamageScale * (1 - l0 / L0_DOME_MAX_HP);
      }
    }

    // Apply stochastic noise + attention to current task only.
    chaseScore = chaseScore * noise() - (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER ? ai.attentionPenalty : 0);
    attackScore = attackScore * noise() - (ai.task.kind === CrawlerTaskKind.ATTACK_TILE ? ai.attentionPenalty : 0);

    if (chaseScore >= attackScore && target) {
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: target.x, targetY: target.y };
    }
    return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: tcx, targetCy: tcy };
  }

  remove(id: number): void {
    this.states.delete(id);
  }

  clear(): void {
    this.states.clear();
  }
}
