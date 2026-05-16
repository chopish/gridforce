import {
  ACTIVE_ATTACKER_PENALTY,
  CHASE_COMMIT_S,
  CrawlerTaskKind,
  L0_DOME_MAX_HP,
  L1_PANEL_MAX_HP,
  MITE_PROFILE,
  POST_KILL_REST_S,
  SCORE_SOFTMAX_TEMPERATURE,
  TASK_REEVAL_INTERVAL_S,
  TaskKind,
  indexOf,
  type CrawlerState,
  type CrawlerTask,
  type EnemyProfile,
  type GridDef,
  type PlayerState,
  type TaskKindValue,
  type TileBuffers,
} from '@gridforce/shared';

// ─── C1.9 LEGACY MITE PROFILE ────────────────────────────────────────────
// The C1.9 decide() path uses this local scoring profile. It is intentionally
// SEPARATE from the shared `MITE_PROFILE` (EnemyProfile) we now import: the
// shared one carries the new C2 fields (detectionRadiusPx, taskWeights, …)
// while this one is the narrow tuple of scoring scalars the legacy softmax
// still references. T7 will retire LEGACY_MITE_PROFILE and read scoring
// fields off the EnemyProfile directly.
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
const LEGACY_MITE_PROFILE = {
  player: 100,
  panelBase: 5,
  panelDamageScale: 15,
  domeBase: 25,
  domeDamageScale: 35,
  attentionPerScan: 5,
  crowdRadiusPx: 128, // 2 tiles — tighter than C1.5's 3
};

// Re-evaluation cadence + commit windows + softmax τ + anti-pile-on +
// post-kill rest are shared C2 tuning constants — see
// `packages/shared/src/constants.ts` for the rationale comments. They were
// promoted out of this file in Task 4 of the C2 priority-AI plan.

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

// ─── Per-bug AI phase ────────────────────────────────────────────────────
// CALM is the wandering / passive default; ENGAGED is set when the bug has
// recently seen or taken damage from a player. T6 will wire phase
// transitions; T5 only declares the field.
type Phase = 'CALM' | 'ENGAGED';

// Per-bug AI state held by the manager. Bug position/hp lives on
// CrawlerState (wire-visible); everything here is server-internal. T5
// widens this from C1.9's 5-field shape to hold every per-bug field the
// C2 priority-AI spec will need. Most NEW fields are unused this commit;
// later tasks (T6 phase, T7 scoring, T10 attack state machine, T12
// stagger, T17 swarm-AI alert) wire them in.
interface CrawlerAi {
  profile: EnemyProfile;
  phase: Phase;
  currentTask: TaskKindValue;

  // Current task's bound target data (T7+). Mirrored on `legacyTask` for
  // the C1.9 path during the transition.
  taskTargetX: number;
  taskTargetY: number;
  taskTargetCx: number;
  taskTargetCy: number;

  // Timers — `reevalInS`, `chaseCommitInS`, `attackRestInS`,
  // `attentionPenalty` carry over from C1.9 and still drive legacyDecide.
  // The rest are scaffolded for T6+.
  reevalInS: number;
  chaseCommitInS: number;
  attackRestInS: number;
  taskCommitmentS: number;  // NEW (T7): time on current task; resets on switch
  attentionPenalty: number;
  engagedIdleS: number;     // NEW (T6): phase-decay timer

  // ATTACK_PLAYER state machine (T10).
  windUpInS: number;
  recoveryInS: number;
  swingFiredThisTick: boolean;
  attackTargetPlayerId: number | null;

  // Stagger accumulator (T12).
  staggerAccumHp: number;
  staggerAccumS: number;

  // Swarm-AI alert state (T17).
  alertBonusInS: number;
  investigateTargetX: number;
  investigateTargetY: number;
  investigateUntilS: number;
  hasInvestigateTarget: boolean;

  // Cached last-known bug position for debug/test accessors (T7+).
  lastBugPos: { x: number; y: number } | null;

  // C1.9-shape task retained so legacyDecide can read/write it until T7
  // replaces this path. Mirrors `currentTask` semantically but uses the
  // existing CrawlerTask discriminated union the executor consumes.
  legacyTask: CrawlerTask;
}

function defaultLegacyTask(): CrawlerTask {
  return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: 0, targetY: 0 };
}

function makeAiState(profile: EnemyProfile): CrawlerAi {
  return {
    profile,
    phase: 'CALM',
    currentTask: profile.startTask,
    taskTargetX: 0, taskTargetY: 0,
    taskTargetCx: 0, taskTargetCy: 0,
    reevalInS: 0,
    chaseCommitInS: 0,
    attackRestInS: 0,
    taskCommitmentS: 0,
    attentionPenalty: 0,
    engagedIdleS: 0,
    windUpInS: 0,
    recoveryInS: 0,
    swingFiredThisTick: false,
    attackTargetPlayerId: null,
    staggerAccumHp: 0,
    staggerAccumS: 0,
    alertBonusInS: 0,
    investigateTargetX: 0, investigateTargetY: 0,
    investigateUntilS: 0,
    hasInvestigateTarget: false,
    lastBugPos: null,
    legacyTask: defaultLegacyTask(),
  };
}

export class CrawlerAiManager {
  private states = new Map<number, CrawlerAi>();

  // Called by Room when an enemy spawns. C2 v1 uses MITE_PROFILE for all
  // crawlers; future enemy types will dispatch by their own profile.
  registerCrawler(id: number, profile: EnemyProfile = MITE_PROFILE): void {
    this.states.set(id, makeAiState(profile));
  }

  // O(n) but n ≤ MAX_ALIVE_CRAWLERS ≈ 25; cheap. Called once per decide()
  // so each bug sees the current attacker count when scoring.
  private activeAttackerCount(): number {
    let n = 0;
    for (const ai of this.states.values()) {
      if (ai.legacyTask.kind === CrawlerTaskKind.ATTACK_TILE) n++;
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
      // Defensive: a crawler that wasn't pre-registered (e.g. unit-test
      // path that constructs CrawlerState directly) gets the mite profile.
      ai = makeAiState(MITE_PROFILE);
      this.states.set(c.id, ai);
    }
    ai.lastBugPos = { x: c.x, y: c.y };

    // Tick the new C2 timers each decide(). Only the C1.9-relevant ones
    // (reevalInS / chaseCommitInS / attackRestInS) drive behavior today;
    // the rest are scaffolded for later tasks. The legacyDecide path
    // ticks reevalInS / chaseCommitInS / attackRestInS itself, so we
    // ONLY tick the new fields here to keep behavior identical.
    ai.taskCommitmentS += dt;
    ai.alertBonusInS = Math.max(0, ai.alertBonusInS - dt);
    ai.staggerAccumS += dt;
    if (ai.staggerAccumS >= ai.profile.staggerWindowS) {
      ai.staggerAccumHp = 0;
      ai.staggerAccumS = 0;
    }

    // Compute effective detection radius. The SEARCH-widen and alert-bonus
    // multipliers are wired here; their inputs (ai.currentTask, alertBonusInS)
    // are scaffolded today and exercised by T8 / T17.
    const near = nearestPlayer(c, players);
    let effectiveR = ai.profile.detectionRadiusPx;
    // SEARCH widens detection so a wandering bug spots pilots from farther.
    // Wired today (the field is set by T8's task picker) but mites still
    // pick SEARCH only after T8 lands.
    if (ai.currentTask === TaskKind.SEARCH) effectiveR *= ai.profile.searchRadiusMult;
    // CALL_ALERT receivers get a temporary detection bonus (T17 sets the
    // timer; harmless when alertBonusInS == 0).
    if (ai.alertBonusInS > 0) effectiveR *= ai.profile.alertBonusMult;
    const effectiveR2 = effectiveR * effectiveR;
    const detected = !!near && near.dist2 <= effectiveR2;

    // CALM → ENGAGED: detection, alert (hasInvestigateTarget), or damage.
    if (ai.phase === 'CALM') {
      if (detected || ai.hasInvestigateTarget) {
        ai.phase = 'ENGAGED';
        ai.engagedIdleS = 0;
      }
    }

    // ENGAGED → CALM: engagedDecayS seconds with no detection, no alert
    // target, and not currently in wind-up/recovery.
    if (ai.phase === 'ENGAGED') {
      const hasInterest = detected || ai.hasInvestigateTarget ||
        ai.windUpInS > 0 || ai.recoveryInS > 0;
      if (hasInterest) {
        ai.engagedIdleS = 0;
      } else {
        ai.engagedIdleS += dt;
        if (ai.engagedIdleS >= ai.profile.engagedDecayS) {
          ai.phase = 'CALM';
        }
      }
    }

    // Decay the investigate target.
    if (ai.hasInvestigateTarget) {
      ai.investigateUntilS -= dt;
      if (ai.investigateUntilS <= 0) ai.hasInvestigateTarget = false;
    }

    // TEMPORARY: defer to the C1.9 logic until later tasks wire in the
    // new task selection. Behavior is identical to pre-T5.
    return this.legacyDecide(c, ai, dt, players, bugs, tiles, grid);
  }

  // Test/debug accessor.
  getPhase(crawlerId: number): 'CALM' | 'ENGAGED' | null {
    return this.states.get(crawlerId)?.phase ?? null;
  }

  // Test/debug accessor for INVESTIGATE target.
  getInvestigateTarget(crawlerId: number): { x: number; y: number } | null {
    const ai = this.states.get(crawlerId);
    if (!ai || !ai.hasInvestigateTarget) return null;
    return { x: ai.investigateTargetX, y: ai.investigateTargetY };
  }

  // Preserved C1.9 decide() logic — translates `ai.task` → `ai.legacyTask`
  // and otherwise reads the same fields as before. Will be removed once
  // T7+ wires the new task-selection path. Inlined here so existing tests
  // pass through this refactor untouched.
  private legacyDecide(
    c: CrawlerState,
    ai: CrawlerAi,
    dt: number,
    players: ReadonlyArray<PlayerState>,
    bugs: ReadonlyArray<CrawlerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): CrawlerTask {
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
      ai.legacyTask = {
        kind: CrawlerTaskKind.CHASE_PLAYER,
        targetX: near.player.x,
        targetY: near.player.y,
      };
      ai.attentionPenalty = 0;
      ai.chaseCommitInS = CHASE_COMMIT_S;
      // Reset reeval too so we don't immediately re-score right after the
      // forced aggro — let the chase stick for the commit window.
      ai.reevalInS = TASK_REEVAL_INTERVAL_S;
      return ai.legacyTask;
    }

    // Commit-until-completion for ATTACK tasks.
    if (ai.legacyTask.kind === CrawlerTaskKind.ATTACK_TILE) {
      const tcx = ai.legacyTask.targetCx;
      const tcy = ai.legacyTask.targetCy;
      const inBounds = tcx >= 0 && tcx < grid.cols && tcy >= 0 && tcy < grid.rows;
      if (inBounds) {
        const idx = indexOf(grid.cols, tcx, tcy);
        const stillAttackable = tiles.l1Hp[idx]! > 0 || tiles.l0Hp[idx]! > 0;
        if (stillAttackable) {
          if (ai.reevalInS <= 0) {
            ai.attentionPenalty += LEGACY_MITE_PROFILE.attentionPerScan;
            ai.reevalInS = TASK_REEVAL_INTERVAL_S;
          }
          return ai.legacyTask;
        }
        // Tile dead — task complete. Trigger the post-kill rest so this
        // bug doesn't immediately commit to the next adjacent tile.
        ai.attackRestInS = POST_KILL_REST_S;
      }
    }

    // Chase commitment — short lock so the bug doesn't flap to a different
    // task every single scan.
    if (ai.legacyTask.kind === CrawlerTaskKind.CHASE_PLAYER && ai.chaseCommitInS > 0 && ai.reevalInS > 0) {
      if (near) {
        ai.legacyTask = {
          kind: CrawlerTaskKind.CHASE_PLAYER,
          targetX: near.player.x,
          targetY: near.player.y,
        };
      }
      return ai.legacyTask;
    }

    // Within the reeval window but not commit-locked → keep current task,
    // refreshing the chase target each tick if applicable.
    if (ai.reevalInS > 0) {
      if (ai.legacyTask.kind === CrawlerTaskKind.CHASE_PLAYER && near) {
        ai.legacyTask = {
          kind: CrawlerTaskKind.CHASE_PLAYER,
          targetX: near.player.x,
          targetY: near.player.y,
        };
      }
      return ai.legacyTask;
    }

    const newTask = this.score(c, ai, players, bugs, tiles, grid);
    const sameKind = newTask.kind === ai.legacyTask.kind;
    const sameTarget = sameKind && newTask.kind === CrawlerTaskKind.ATTACK_TILE
      && ai.legacyTask.kind === CrawlerTaskKind.ATTACK_TILE
      && newTask.targetCx === ai.legacyTask.targetCx
      && newTask.targetCy === ai.legacyTask.targetCy;
    if (!sameKind || (newTask.kind === CrawlerTaskKind.ATTACK_TILE && !sameTarget)) {
      ai.legacyTask = newTask;
      ai.attentionPenalty = 0;
      ai.chaseCommitInS = newTask.kind === CrawlerTaskKind.CHASE_PLAYER ? CHASE_COMMIT_S : 0;
    } else {
      ai.legacyTask = newTask;
      ai.attentionPenalty += LEGACY_MITE_PROFILE.attentionPerScan;
    }
    ai.reevalInS = TASK_REEVAL_INTERVAL_S;
    return ai.legacyTask;
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
      const crowd = countNearbyBugs(c, bugs, LEGACY_MITE_PROFILE.crowdRadiusPx);
      chaseScore = LEGACY_MITE_PROFILE.player - crowdPenalty(crowd);
    }

    // Attack — score is layer-aware. Dome (L0 exposed) is always wider-
    // scored than panel, conveying the "dome breach is urgent" signal.
    let attackScore = -Infinity;
    if (inBounds) {
      const idx = indexOf(grid.cols, tcx, tcy);
      const l1 = tiles.l1Hp[idx]!;
      const l0 = tiles.l0Hp[idx]!;
      if (l1 > 0) {
        attackScore = LEGACY_MITE_PROFILE.panelBase + LEGACY_MITE_PROFILE.panelDamageScale * (1 - l1 / L1_PANEL_MAX_HP);
      } else if (l0 > 0) {
        attackScore = LEGACY_MITE_PROFILE.domeBase + LEGACY_MITE_PROFILE.domeDamageScale * (1 - l0 / L0_DOME_MAX_HP);
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
        (ai.legacyTask.kind === CrawlerTaskKind.CHASE_PLAYER ? ai.attentionPenalty : 0);
    }
    if (Number.isFinite(attackScore)) {
      attackScore =
        attackScore * noise() -
        (ai.legacyTask.kind === CrawlerTaskKind.ATTACK_TILE ? ai.attentionPenalty : 0);
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
    return ai.legacyTask;
  }

  remove(id: number): void {
    this.states.delete(id);
  }

  clear(): void {
    this.states.clear();
  }

  // Hook for T12: damage taken increments the stagger accumulator and
  // seeds an INVESTIGATE target for the swarm. Phase transition to
  // ENGAGED on damage is wired in T6; the SWING-cancel side-effect lands
  // in T12. T5 just records the data so the call site can be added now.
  onDamageTaken(crawlerId: number, dmg: number, sourceX: number, sourceY: number): void {
    const ai = this.states.get(crawlerId);
    if (!ai) return;
    ai.staggerAccumHp += dmg;
    ai.staggerAccumS = 0;
    ai.hasInvestigateTarget = true;
    ai.investigateTargetX = sourceX;
    ai.investigateTargetY = sourceY;
    ai.investigateUntilS = ai.profile.investigateStaleS;
  }
}
