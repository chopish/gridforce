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

// Mite baseline priority profile.
//
//   - `player` is the base score for chasing a pilot. Crowd boredom is a
//     piecewise curve (see crowdPenalty below) that DIPS for a tight squad
//     (2-4 peers nearby) — a coherent pack chases harder — then climbs
//     quadratically once the group passes ~6 peers, hitting critical mass
//     in the 12-15 range where chasing the player breaks down.
//   - Attack score is layer-aware. Panels are MILDLY appealing baseline —
//     `panelBase` lives just below the chase score so the per-roll noise
//     bands overlap, producing a low natural probability that a lone mite
//     commits to the tile under it. Score climbs as the panel takes
//     damage, then jumps into a much higher band when L1 is gone and the
//     dome is exposed; dome-exposed tiles still dominate at any crowd
//     size. The "small chance per roll" behaviour is therefore an
//     emergent property of the score band overlap + stochastic noise —
//     no hardcoded probability gate elsewhere in this file.
//   - Attention is the per-scan boredom penalty on whichever task is
//     currently active. Slower decay than C1.5 since rolls are less
//     frequent (see TASK_REEVAL_INTERVAL_S below).
//
// Tuning intuition for the panel band: chase = 100 with ±15% noise spans
// 85–115. `panelBase = 80` with ±15% noise spans 68–92. The narrow
// overlap (85–92) is where attack can win — only a few percent per roll
// at lone-mite-healthy-panel, rising as the panel takes damage. Tight
// squads (chase ≈ 110) never overlap, so squads stay committed to the
// chase. Critical mass (chase ≪ 70) puts attack firmly above chase.
//
// TODO (future): proper swarm AI — formation, lead-follow, designated
// breachers. The crowd-dip term is a stand-in for "coherent squad
// behaviour" until that lands.
const MITE_PROFILE = {
  player: 100,
  panelBase: 80,
  panelDamageScale: 15,
  domeBase: 100,
  domeDamageScale: 35,
  attentionPerScan: 5,
  crowdRadiusPx: 128, // 2 tiles — tighter than C1.5's 3
};

// Priority rolls used to fire every 0.5s in C1.5. Even at low odds of
// switching, a frequent roll guarantees a switch within a minute or so
// purely from the stochastic tail. Slowing the roll cadence to 2s lets
// commitment actually mean something — and the player's movement is still
// tracked smoothly because chase targets refresh every tick regardless of
// the reeval cadence.
const TASK_REEVAL_INTERVAL_S = 2.0;
// Commit lock applied after switching INTO a chase task. Attacks use a
// different lock — they're committed-until-completion (the tile being
// destroyed) and ignore this constant.
const CHASE_COMMIT_S = 2.0;

// Crowd-boredom curve. n = #peers within crowdRadiusPx.
//   n = 0       →  0   (lone bug: no effect)
//   n = 2..4    → -10  (tight squad: chase is REINFORCED)
//   n = 5..6    →  ~0  (returning to neutral)
//   n = 8       →  +18
//   n = 10      →  +50
//   n = 13+     →  +100+ (critical mass; chasing folds to attacking)
// Squad bonus dips between n=1 and n=5 with a peak at n=3. Above n=5 the
// penalty rises as (n-5)² × 2 — flat-ish into the medium range and steep
// once the swarm tips over.
function crowdPenalty(n: number): number {
  if (n <= 0) return 0;
  if (n <= 3) return -10 * (n / 3);
  if (n <= 5) return -10 * (5 - n) / 2;
  const excess = n - 5;
  return excess * excess * 2;
}

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

    // Chase — base 100, modulated by the squad/swarm crowd curve. Small
    // groups boost it (coherent pack); large groups break it down.
    let chaseScore = -Infinity;
    if (target) {
      const crowd = countNearbyBugs(c, bugs, MITE_PROFILE.crowdRadiusPx);
      chaseScore = MITE_PROFILE.player - crowdPenalty(crowd);
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

    // Apply stochastic noise + attention to current task only. The noise
    // bands on chase and attack are where the "low baseline chance of a
    // lone mite attacking the tile under it" comes from — panelBase sits
    // close enough to `player` that the bands overlap on the tails. No
    // separate probability gate.
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
