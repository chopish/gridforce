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

// Mite priority profile.
//
//   - `player` is the base score for chasing a pilot. Crowd boredom is a
//     piecewise curve (see crowdPenalty below) that DIPS for a tight squad
//     (2-4 peers nearby) — a coherent pack chases harder — then climbs
//     quadratically once the group passes ~6 peers, hitting critical mass
//     in the 12-15 range where chasing the player breaks down.
//   - Attack scores are layer-aware. Healthy panels are intentionally
//     unappealing on their own (panelBase tiny); priority climbs as the
//     panel takes damage, then jumps to a much higher band when L1 is gone
//     and the dome is exposed. The score gap between panel and dome is
//     what conveys "dome breach is urgent" — keep it wide.
//   - Final pick is SOFTMAX over (chaseScore, attackScore), not argmax. A
//     lone mite on a healthy panel sees chase=100, attack=5 — softmax
//     gives attack a low but non-zero probability per roll. As the swarm
//     grows and chaseScore is eroded by crowdPenalty, the attack
//     probability climbs SMOOTHLY rather than flipping all at once.
const MITE_PROFILE = {
  player: 100,
  panelBase: 5,
  panelDamageScale: 15,
  domeBase: 25,
  domeDamageScale: 35,
  attentionPerScan: 5,
  crowdRadiusPx: 128, // 2 tiles — tighter than C1.5's 3
};

// Re-evaluation cadence. Each bug rolls its task this often (assuming no
// task is currently held — see commit windows below). Higher = stickier
// decisions, lower = floppier. 4s gives roughly 15 rolls/minute/bug; at
// the softmax-derived ~3% attack probability for a lone mite on a healthy
// panel, that's ~0.5 attack-switches/min/bug — sparse enough that the
// pattern reads as "occasional breachers" not "constant flip-flopping".
const TASK_REEVAL_INTERVAL_S = 4.0;
// Commit lock applied after switching INTO a chase task. Attack tasks
// commit-until-tile-destroyed instead (see decide).
const CHASE_COMMIT_S = 4.0;

// Softmax temperature. Probability of picking attack over chase is
//   exp(attack/τ) / (exp(chase/τ) + exp(attack/τ))
// At τ=30: a 95-point gap (lone mite, healthy panel) gives the loser ≈3%;
// a 40-point gap (lone mite, intact dome) gives ≈22%; equal scores give
// 50/50. Lower τ → closer to argmax; higher τ → closer to uniform.
const SCORE_SOFTMAX_TEMPERATURE = 30;

// Anti-pile-on. For each bug currently committed to an ATTACK_TILE task
// across the level, subtract this from `attackScore` at decision time.
// First breacher sees the full score; the 5th sees -15; the 10th sees
// -30 — usually below any plausible chase score, so attack stops being
// picked. Self-balances breacher count without a hard cap.
const ACTIVE_ATTACKER_PENALTY = 3;

// After a bug finishes destroying its tile, force-block ATTACK picks for
// this long. Kills the "tile dies → bug instantly picks the adjacent
// tile" pile-on. Bug must chase or hover for the rest window before
// becoming eligible to commit to another tile.
const POST_KILL_REST_S = 5.0;

// Passive player-proximity aggro. Any non-chase task is interrupted (no
// matter the commit state) the moment a player crosses this radius.
// Future: per-player aggro multipliers (loud attacks, taunt skills, etc.)
// can widen this conditionally — for now it's a flat threshold.
const PLAYER_AGGRO_RADIUS_PX = 192; // 3 tiles
const PLAYER_AGGRO_RADIUS_SQ = PLAYER_AGGRO_RADIUS_PX * PLAYER_AGGRO_RADIUS_PX;

// Crowd-boredom curve. n = #peers within crowdRadiusPx.
//   n = 0       →  0   (lone bug: no effect)
//   n = 2..4    → -10  (tight squad: chase is REINFORCED)
//   n = 5..6    →  ~0  (returning to neutral)
//   n = 8       →  +18
//   n = 10      →  +50
//   n = 13+     →  +100+ (critical mass; chasing collapses)
// Squad bonus dips between n=1 and n=5 with a peak at n=3. Above n=5 the
// penalty rises as (n-5)² × 2 — flat-ish into the medium range and steep
// once the swarm tips over. Combined with softmax sampling, the
// "critical mass" transition is a SMOOTH probability ramp rather than a
// binary flip — more bugs join the attack as chaseScore falls, not all
// at once.
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

function nearestPlayer(c: CrawlerState, players: ReadonlyArray<PlayerState>): {
  player: PlayerState;
  dist2: number;
} | null {
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
  return best ? { player: best, dist2: bestD2 } : null;
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

// Sample a binary choice with softmax probabilities. Returns `true` for
// attack, `false` for chase. -Infinity scores are treated as ineligible.
function pickSoftmax(chaseScore: number, attackScore: number, tau: number): 'chase' | 'attack' {
  const chaseEligible = Number.isFinite(chaseScore);
  const attackEligible = Number.isFinite(attackScore);
  if (!chaseEligible && !attackEligible) return 'chase';
  if (!chaseEligible) return 'attack';
  if (!attackEligible) return 'chase';
  // Numerical stability: subtract the max before exponentiating.
  const m = Math.max(chaseScore, attackScore);
  const eC = Math.exp((chaseScore - m) / tau);
  const eA = Math.exp((attackScore - m) / tau);
  const pAttack = eA / (eC + eA);
  return Math.random() < pAttack ? 'attack' : 'chase';
}

interface CrawlerAi {
  task: CrawlerTask;
  attentionPenalty: number;
  reevalInS: number;
  // Time left in the chase-commit window. ATTACK tasks ignore this — they
  // hold until the target tile is destroyed.
  chaseCommitInS: number;
  // Post-kill rest. While >0, this bug cannot pick ATTACK_TILE. Reset to
  // POST_KILL_REST_S when an ATTACK task ends because the tile died.
  attackRestInS: number;
}

function defaultTask(): CrawlerTask {
  return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: 0, targetY: 0 };
}

export class CrawlerAiManager {
  private states = new Map<number, CrawlerAi>();

  // O(n) but n ≤ MAX_ALIVE_CRAWLERS ≈ 25; cheap. Called once per decide()
  // so each bug sees the current attacker count when scoring.
  private activeAttackerCount(): number {
    let n = 0;
    for (const ai of this.states.values()) {
      if (ai.task.kind === CrawlerTaskKind.ATTACK_TILE) n++;
    }
    return n;
  }

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
      ai = {
        task: defaultTask(),
        attentionPenalty: 0,
        reevalInS: 0,
        chaseCommitInS: 0,
        attackRestInS: 0,
      };
      this.states.set(c.id, ai);
    }
    ai.chaseCommitInS = Math.max(0, ai.chaseCommitInS - dt);
    ai.attackRestInS = Math.max(0, ai.attackRestInS - dt);
    ai.reevalInS -= dt;

    // Passive aggro. A nearby player is a hard interrupt: regardless of
    // current task or commit state, the bug breaks off and chases. This
    // is the first thing the future "player aggro modifiers" will hook
    // into — increase the radius conditionally per player to model loud
    // actions, taunts, etc.
    const near = nearestPlayer(c, players);
    if (near && near.dist2 <= PLAYER_AGGRO_RADIUS_SQ) {
      ai.task = {
        kind: CrawlerTaskKind.CHASE_PLAYER,
        targetX: near.player.x,
        targetY: near.player.y,
      };
      ai.attentionPenalty = 0;
      ai.chaseCommitInS = CHASE_COMMIT_S;
      // Reset reeval too so we don't immediately re-score right after the
      // forced aggro — let the chase stick for the commit window.
      ai.reevalInS = TASK_REEVAL_INTERVAL_S;
      return ai.task;
    }

    // Commit-until-completion for ATTACK tasks.
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
        // Tile dead — task complete. Trigger the post-kill rest so this
        // bug doesn't immediately commit to the next adjacent tile.
        ai.attackRestInS = POST_KILL_REST_S;
      }
    }

    // Chase commitment — short lock so the bug doesn't flap to a different
    // task every single scan.
    if (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER && ai.chaseCommitInS > 0 && ai.reevalInS > 0) {
      if (near) {
        ai.task = {
          kind: CrawlerTaskKind.CHASE_PLAYER,
          targetX: near.player.x,
          targetY: near.player.y,
        };
      }
      return ai.task;
    }

    // Within the reeval window but not commit-locked → keep current task,
    // refreshing the chase target each tick if applicable.
    if (ai.reevalInS > 0) {
      if (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER && near) {
        ai.task = {
          kind: CrawlerTaskKind.CHASE_PLAYER,
          targetX: near.player.x,
          targetY: near.player.y,
        };
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
    const near = nearestPlayer(c, players);
    const tcx = Math.floor(c.x / grid.panelSize);
    const tcy = Math.floor(c.y / grid.panelSize);
    const inBounds = tcx >= 0 && tcx < grid.cols && tcy >= 0 && tcy < grid.rows;

    // Chase — base score modulated by the squad/swarm crowd curve. Tight
    // packs reinforce chase; large crowds erode it (critical mass).
    let chaseScore = -Infinity;
    if (near) {
      const crowd = countNearbyBugs(c, bugs, MITE_PROFILE.crowdRadiusPx);
      chaseScore = MITE_PROFILE.player - crowdPenalty(crowd);
    }

    // Attack — score is layer-aware. Dome (L0 exposed) is always wider-
    // scored than panel, conveying the "dome breach is urgent" signal.
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

    // Post-kill rest: bug literally cannot pick attack right now.
    if (ai.attackRestInS > 0) {
      attackScore = -Infinity;
    }

    // Global anti-pile-on: each existing attacker on the level pulls the
    // attack score down. By the time ~5-8 bugs are attacking, joining
    // them costs more than the panel/dome score itself, so new bugs stay
    // on chase.
    if (Number.isFinite(attackScore)) {
      attackScore -= ACTIVE_ATTACKER_PENALTY * this.activeAttackerCount();
    }

    // Stochastic noise + per-task attention penalty. Noise stays for
    // micro-variation; the heavy lifting on stochasticity now lives in
    // the softmax sampler below.
    if (Number.isFinite(chaseScore)) {
      chaseScore =
        chaseScore * noise() -
        (ai.task.kind === CrawlerTaskKind.CHASE_PLAYER ? ai.attentionPenalty : 0);
    }
    if (Number.isFinite(attackScore)) {
      attackScore =
        attackScore * noise() -
        (ai.task.kind === CrawlerTaskKind.ATTACK_TILE ? ai.attentionPenalty : 0);
    }

    const pick = pickSoftmax(chaseScore, attackScore, SCORE_SOFTMAX_TEMPERATURE);
    if (pick === 'chase' && near) {
      return {
        kind: CrawlerTaskKind.CHASE_PLAYER,
        targetX: near.player.x,
        targetY: near.player.y,
      };
    }
    if (pick === 'attack' && inBounds) {
      return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: tcx, targetCy: tcy };
    }
    // Degenerate case: neither task is viable. Hold current task; the
    // next tick will re-evaluate as state changes (a player respawns, the
    // bug walks onto a new tile, etc.).
    return ai.task;
  }

  remove(id: number): void {
    this.states.delete(id);
  }

  clear(): void {
    this.states.clear();
  }
}
