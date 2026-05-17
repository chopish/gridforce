import {
  ACTIVE_ATTACKER_PENALTY,
  ATTACK_COMMITMENT_DECAY_S,
  ATTACK_COMMITMENT_FLOOR,
  ATTENTION_PER_SCAN,
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

// Re-evaluation cadence + commit windows + softmax τ + anti-pile-on +
// post-kill rest are shared C2 tuning constants — see
// `packages/shared/src/constants.ts` for the rationale comments. They were
// promoted out of this file in Task 4 of the C2 priority-AI plan.

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

  // Current task's bound target data (T7+).
  taskTargetX: number;
  taskTargetY: number;
  taskTargetCx: number;
  taskTargetCy: number;

  // Timers — `reevalInS`, `chaseCommitInS`, `attackRestInS`,
  // `attentionPenalty` carry over from C1.9. The rest are scaffolded for T6+.
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
  };
}

function taskKindToCrawlerTask(
  task: TaskKindValue,
  ai: CrawlerAi,
  bug: { x: number; y: number },
  players: ReadonlyArray<PlayerState>,
  grid: GridDef,
): CrawlerTask {
  switch (task) {
    case TaskKind.SEEK_PLAYER:
    case TaskKind.ATTACK_PLAYER: {
      const fakeBug: CrawlerState = {
        id: 0, x: bug.x, y: bug.y, facing: 0, hp: 1,
        targetCx: 0, targetCy: 0, ai: 0, windUpInS: 0,
      };
      const near = nearestPlayer(fakeBug, players);
      return {
        kind: CrawlerTaskKind.CHASE_PLAYER,
        targetX: near?.player.x ?? bug.x,
        targetY: near?.player.y ?? bug.y,
      };
    }
    case TaskKind.SEEK_TILE:
      return {
        kind: CrawlerTaskKind.SEEK_TILE,
        targetCx: ai.taskTargetCx,
        targetCy: ai.taskTargetCy,
      };
    case TaskKind.ATTACK_TILE: {
      const tcx = Math.floor(bug.x / grid.panelSize);
      const tcy = Math.floor(bug.y / grid.panelSize);
      return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: tcx, targetCy: tcy };
    }
    case TaskKind.SEARCH:
      return {
        kind: CrawlerTaskKind.SEARCH,
        targetX: ai.taskTargetX,
        targetY: ai.taskTargetY,
      };
    case TaskKind.INVESTIGATE:
      return {
        kind: CrawlerTaskKind.CHASE_PLAYER,
        targetX: ai.taskTargetX || bug.x,
        targetY: ai.taskTargetY || bug.y,
      };
    case TaskKind.IDLE:
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: bug.x, targetY: bug.y };
    default:
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: bug.x, targetY: bug.y };
  }
}

export class CrawlerAiManager {
  private states = new Map<number, CrawlerAi>();

  // Called by Room when an enemy spawns. C2 v1 uses MITE_PROFILE for all
  // crawlers; future enemy types will dispatch by their own profile.
  registerCrawler(id: number, profile: EnemyProfile = MITE_PROFILE): void {
    this.states.set(id, makeAiState(profile));
  }

  // Test-only: force a crawler's currentTask without going through decide().
  // Used by integrity / e2e tests that want to pin a bug to ATTACK_TILE so the
  // weight-integrity loop has a stable target. Production paths never call
  // this; the priority-AI picks tasks via decide(). Auto-registers if needed.
  __forceTaskForTest(id: number, task: TaskKindValue): void {
    let ai = this.states.get(id);
    if (!ai) {
      ai = makeAiState(MITE_PROFILE);
      this.states.set(id, ai);
    }
    ai.currentTask = task;
    // Park reeval far in the future so decide()'s re-pick doesn't immediately
    // swap us back to SEEK_PLAYER. Matches the "committed to a task" intent.
    ai.reevalInS = 1e9;
  }

  // Test hook: pin the bug's currentTask AND run the task-switch
  // bookkeeping (target seeding, reset of commitment timers, etc.) that
  // decide() would normally run on entry to the new task. Used by tests
  // that want to inspect the per-task entry side-effects without standing
  // up the full softmax sampling path.
  //
  // For SEEK_TILE: seeds taskTargetCx/Cy from the best damaged tile in
  // range via findBestSeekTile. Requires `tiles` and `grid` for that case.
  // Auto-registers an unknown crawler with MITE_PROFILE (matching
  // __forceTaskForTest), but seeding is skipped if lastBugPos is unknown
  // (caller must run decide() once first to populate it).
  forceTask(
    id: number,
    task: TaskKindValue,
    tiles?: TileBuffers,
    grid?: GridDef,
  ): void {
    let ai = this.states.get(id);
    if (!ai) {
      ai = makeAiState(MITE_PROFILE);
      this.states.set(id, ai);
    }
    ai.currentTask = task;
    ai.taskCommitmentS = 0;
    ai.attentionPenalty = 0;
    // For SEEK_TILE, seed the target from the best damaged tile in range.
    if (task === TaskKind.SEEK_TILE && ai.lastBugPos && tiles && grid) {
      const best = this.findBestSeekTile(
        ai.lastBugPos, ai.profile.seekTileRadiusPx, tiles, grid,
      );
      if (best) {
        ai.taskTargetCx = best.tx;
        ai.taskTargetCy = best.ty;
        ai.taskTargetX = (best.tx + 0.5) * grid.panelSize;
        ai.taskTargetY = (best.ty + 0.5) * grid.panelSize;
      }
    }
    // For SEARCH, seed a random wander target within seekTileRadiusPx of
    // the bug's last known position. The executor will walk toward it
    // (slower than chase) and the manager will reroll on arrival.
    if (task === TaskKind.SEARCH && ai.lastBugPos) {
      const r = ai.profile.seekTileRadiusPx;
      const angle = Math.random() * Math.PI * 2;
      const dist = r * (0.5 + Math.random() * 0.5);
      ai.taskTargetX = ai.lastBugPos.x + Math.cos(angle) * dist;
      ai.taskTargetY = ai.lastBugPos.y + Math.sin(angle) * dist;
    }
    // For INVESTIGATE, copy the seeded alert target (from onDamageTaken /
    // CALL_ALERT) into the task target so the executor walks toward it.
    if (task === TaskKind.INVESTIGATE && ai.hasInvestigateTarget) {
      ai.taskTargetX = ai.investigateTargetX;
      ai.taskTargetY = ai.investigateTargetY;
    }
    // For SEEK_PLAYER, broadcast a CALL_ALERT to peers within
    // alertPropagationRadiusPx so the swarm reacts to the peel-off (T17).
    // Mirrors the natural-selection broadcast in decide()'s task-switch
    // block so tests can drive the side-effect via forceTask.
    if (task === TaskKind.SEEK_PLAYER && ai.lastBugPos) {
      this.broadcastCallAlert(
        id,
        ai.lastBugPos.x,
        ai.lastBugPos.y,
        ai.profile.alertPropagationRadiusPx,
      );
    }
    // Park reeval far in the future so decide()'s re-pick doesn't immediately
    // swap us back. Matches the "committed to a task" intent.
    ai.reevalInS = 1e9;
  }

  // T17: Swarm-AI CALL_ALERT broadcast. When a bug enters SEEK_PLAYER as a
  // new task (the peel-off moment), peers within alertPropagationRadiusPx
  // receive a phase flip CALM→ENGAGED, alertBonusInS set, and an
  // INVESTIGATE target seeded at the alerter's position. Future enemy
  // types can widen/shrink the radius or boost duration via their profile.
  private broadcastCallAlert(
    alerterId: number,
    x: number,
    y: number,
    radiusPx: number,
  ): void {
    const r2 = radiusPx * radiusPx;
    for (const [peerId, peerAi] of this.states) {
      if (peerId === alerterId) continue;
      if (!peerAi.lastBugPos) continue;
      const dx = peerAi.lastBugPos.x - x;
      const dy = peerAi.lastBugPos.y - y;
      if (dx * dx + dy * dy > r2) continue;
      // Receiver: phase flip + alert bonus + investigate seed.
      peerAi.hasInvestigateTarget = true;
      peerAi.investigateTargetX = x;
      peerAi.investigateTargetY = y;
      peerAi.investigateUntilS = peerAi.profile.investigateStaleS;
      peerAi.alertBonusInS = peerAi.profile.alertBonusDurS;
      if (peerAi.phase === 'CALM') peerAi.phase = 'ENGAGED';
    }
  }

  // O(n) but n ≤ MAX_ALIVE_CRAWLERS ≈ 25; cheap. Called once per decide()
  // so each bug sees the current attacker count when scoring.
  private activeAttackerCount(): number {
    let n = 0;
    for (const ai of this.states.values()) {
      if (ai.currentTask === TaskKind.ATTACK_TILE) n++;
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

    // Tick the C2 timers each decide(). Per-task commitment, alert-bonus,
    // and stagger-window all decay here; reevalInS / chaseCommitInS /
    // attackRestInS are ticked further below alongside the task-selection
    // hierarchy so the read-points stay close to the writes.
    ai.taskCommitmentS += dt;
    ai.alertBonusInS = Math.max(0, ai.alertBonusInS - dt);
    ai.staggerAccumS += dt;
    if (ai.staggerAccumS >= ai.profile.staggerWindowS) {
      ai.staggerAccumHp = 0;
      ai.staggerAccumS = 0;
    }

    // ATTACK_PLAYER state machine: WIND_UP timer countdown → SWING → RECOVERY.
    //
    // Stagger interrupt (T12 wires the accumulator; today the check is a
    // no-op because staggerAccumHp is always 0). When the threshold trips,
    // skip the swing fire and jump straight to RECOVERY.
    //
    // While WIND_UP or RECOVERY is active, skip task re-selection — bug is
    // locked into the swing+recovery cycle.
    ai.swingFiredThisTick = false;
    if (ai.windUpInS > 0) {
      ai.windUpInS -= dt;
      if (ai.staggerAccumHp >= ai.profile.staggerThresholdHp) {
        // Stagger interrupt — skip swing, jump to RECOVERY.
        ai.windUpInS = 0;
        ai.recoveryInS = ai.profile.recoveryDurS;
        ai.staggerAccumHp = 0;
        ai.staggerAccumS = 0;
      } else if (ai.windUpInS <= 0) {
        // Timer expired → fire swing → RECOVERY.
        ai.windUpInS = 0;
        ai.swingFiredThisTick = true;
        ai.recoveryInS = ai.profile.recoveryDurS;
      }
      // Stay locked in WIND_UP (or transitioning out); skip task re-selection.
      return taskKindToCrawlerTask(TaskKind.ATTACK_PLAYER, ai, c, players, grid);
    }
    if (ai.recoveryInS > 0) {
      ai.recoveryInS -= dt;
      if (ai.recoveryInS <= 0) {
        ai.recoveryInS = 0;
        ai.reevalInS = 0; // force re-priority on the next decide().
        // Reset currentTask so a follow-up ATTACK_PLAYER pick is treated
        // as a fresh transition (and re-arms windUpInS). Without this the
        // task-switch block sees newTask === currentTask and skips the
        // wind-up entry bookkeeping.
        ai.currentTask = TaskKind.IDLE;
      }
      return taskKindToCrawlerTask(TaskKind.IDLE, ai, c, players, grid);
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
    // T16: ATTACK_TILE commitment shrinks effective detection. A bug
    // committed to chewing a tile for `ATTACK_COMMITMENT_DECAY_S` seconds
    // drops to `ATTACK_COMMITMENT_FLOOR` of its base radius — players must
    // shock it, not just walk past, to peel it off.
    if (ai.currentTask === TaskKind.ATTACK_TILE) {
      const t = Math.min(1, ai.taskCommitmentS / ATTACK_COMMITMENT_DECAY_S);
      effectiveR *= 1 - t * (1 - ATTACK_COMMITMENT_FLOOR);
    }
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

    // Tick reeval/commit timers for the new path.
    ai.reevalInS -= dt;
    ai.chaseCommitInS = Math.max(0, ai.chaseCommitInS - dt);
    ai.attackRestInS = Math.max(0, ai.attackRestInS - dt);

    // Hierarchical task selection.
    //
    // 1. If committed (chase commit window, ATTACK_TILE on a live tile),
    //    keep the current task.
    // 2. Otherwise re-evaluate (when reevalInS <= 0).
    // 3. Convert TaskKindValue → CrawlerTask for the executor.

    // (A) Chase commit window: if SEEK_PLAYER and chaseCommitInS > 0, keep.
    if (ai.currentTask === TaskKind.SEEK_PLAYER && ai.chaseCommitInS > 0) {
      return taskKindToCrawlerTask(TaskKind.SEEK_PLAYER, ai, c, players, grid);
    }

    // (B) ATTACK_TILE committed until tile dies. If the tile is dead,
    // trigger post-kill rest and fall through to re-pick.
    if (ai.currentTask === TaskKind.ATTACK_TILE) {
      const tcx = Math.floor(c.x / grid.panelSize);
      const tcy = Math.floor(c.y / grid.panelSize);
      if (tcx >= 0 && tcx < grid.cols && tcy >= 0 && tcy < grid.rows) {
        const idx = indexOf(grid.cols, tcx, tcy);
        if (tiles.l1Hp[idx]! > 0 || tiles.l0Hp[idx]! > 0) {
          ai.taskTargetCx = tcx;
          ai.taskTargetCy = tcy;
          return taskKindToCrawlerTask(TaskKind.ATTACK_TILE, ai, c, players, grid);
        }
        // Tile dead — kick post-kill rest, fall through to re-pick.
        ai.attackRestInS = POST_KILL_REST_S;
      }
    }

    // (C) Within the reeval window, keep current task; refresh chase
    // target if applicable.
    if (ai.reevalInS > 0) {
      return taskKindToCrawlerTask(ai.currentTask, ai, c, players, grid);
    }

    // (D) Re-evaluate. Pick a new task via softmax.
    const newTask = this.decideTask(c, dt, players, bugs, tiles, grid);

    // Task-switch bookkeeping.
    if (newTask !== ai.currentTask) {
      ai.currentTask = newTask;
      ai.attentionPenalty = 0;
      ai.taskCommitmentS = 0;
      if (newTask === TaskKind.SEEK_PLAYER) {
        ai.chaseCommitInS = CHASE_COMMIT_S;
        // T17: Swarm CALL_ALERT broadcast on the peel-off moment.
        // Peers within alertPropagationRadiusPx flip to ENGAGED + get an
        // INVESTIGATE seed + temporary detection bonus.
        this.broadcastCallAlert(
          c.id,
          c.x,
          c.y,
          ai.profile.alertPropagationRadiusPx,
        );
      } else {
        ai.chaseCommitInS = 0;
      }
      // T10: ATTACK_PLAYER entry arms the wind-up timer. The bug stops
      // moving (executor handles the position freeze via state=WIND_UP)
      // and tracks the chosen target.
      if (newTask === TaskKind.ATTACK_PLAYER) {
        ai.windUpInS = ai.profile.windUpDurS;
        const fakeBug: CrawlerState = {
          id: 0, x: c.x, y: c.y, facing: 0, hp: 1,
          targetCx: 0, targetCy: 0, ai: 0, windUpInS: 0,
        };
        const near = nearestPlayer(fakeBug, players);
        ai.attackTargetPlayerId = near?.player.id ?? null;
      }
      // T13: SEEK_TILE entry seeds taskTargetCx/Cy from the best damaged
      // tile in range. Executor (stepCrawler) reads these to walk the bug
      // toward the tile; on arrival it transitions to ATTACKING so the
      // Room weight-integrity loop picks up the new attacker.
      if (newTask === TaskKind.SEEK_TILE) {
        const best = this.findBestSeekTile(
          { x: c.x, y: c.y }, ai.profile.seekTileRadiusPx, tiles, grid,
        );
        if (best) {
          ai.taskTargetCx = best.tx;
          ai.taskTargetCy = best.ty;
          ai.taskTargetX = (best.tx + 0.5) * grid.panelSize;
          ai.taskTargetY = (best.ty + 0.5) * grid.panelSize;
        }
      }
      // T14: SEARCH entry seeds a random wander target within
      // seekTileRadiusPx of the bug. The executor walks slower than chase
      // (CRAWLER_MOVE_SPEED × 0.7) and emits CrawlerAIState.SEARCHING; the
      // manager re-rolls on arrival via the standard reeval cadence.
      if (newTask === TaskKind.SEARCH) {
        const r = ai.profile.seekTileRadiusPx;
        const angle = Math.random() * Math.PI * 2;
        const dist = r * (0.5 + Math.random() * 0.5);
        ai.taskTargetX = c.x + Math.cos(angle) * dist;
        ai.taskTargetY = c.y + Math.sin(angle) * dist;
      }
      // T15: INVESTIGATE entry copies the seeded alert target into the task
      // target so the executor walks toward it (via the CHASE_PLAYER path
      // in taskKindToCrawlerTask).
      if (newTask === TaskKind.INVESTIGATE && ai.hasInvestigateTarget) {
        ai.taskTargetX = ai.investigateTargetX;
        ai.taskTargetY = ai.investigateTargetY;
      }
    } else {
      ai.attentionPenalty += ATTENTION_PER_SCAN;
    }
    ai.reevalInS = TASK_REEVAL_INTERVAL_S;

    // T15: INVESTIGATE arrival — when the bug reaches the alert target,
    // clear it and force a re-roll (the bug typically goes back to chase
    // or search). Stale-timeout is handled by the phase block above.
    if (ai.currentTask === TaskKind.INVESTIGATE && ai.hasInvestigateTarget) {
      const dx = ai.investigateTargetX - c.x;
      const dy = ai.investigateTargetY - c.y;
      if (Math.hypot(dx, dy) < 16) {
        ai.hasInvestigateTarget = false;
        ai.reevalInS = 0;
      }
    }

    return taskKindToCrawlerTask(newTask, ai, c, players, grid);
  }

  // Test/debug accessor.
  getPhase(crawlerId: number): 'CALM' | 'ENGAGED' | null {
    return this.states.get(crawlerId)?.phase ?? null;
  }

  // Test/debug accessor — returns the internal AI state for inspection.
  getInternalAi(crawlerId: number): Readonly<CrawlerAi> | null {
    return this.states.get(crawlerId) ?? null;
  }

  // Test/debug accessor for INVESTIGATE target.
  getInvestigateTarget(crawlerId: number): { x: number; y: number } | null {
    const ai = this.states.get(crawlerId);
    if (!ai || !ai.hasInvestigateTarget) return null;
    return { x: ai.investigateTargetX, y: ai.investigateTargetY };
  }

  // ─── T7: per-task eligibility predicates + base scoring ─────────────
  // Pure read-only accessors. Not yet wired into decide(); T8 will call
  // them from the new task picker. Tested directly so the next task can
  // build the softmax sampler against a stable surface.
  isTaskEligible(
    crawlerId: number,
    task: TaskKindValue,
    players: ReadonlyArray<PlayerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): boolean {
    const ai = this.states.get(crawlerId);
    if (!ai || !ai.lastBugPos) return false;
    return this.isTaskEligibleFor(ai, ai.lastBugPos, task, players, tiles, grid);
  }

  scoreTask(
    crawlerId: number,
    task: TaskKindValue,
    players: ReadonlyArray<PlayerState>,
    bugs: ReadonlyArray<CrawlerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): number {
    const ai = this.states.get(crawlerId);
    if (!ai || !ai.lastBugPos) return -Infinity;
    return this.scoreTaskFor(ai, ai.lastBugPos, task, players, bugs, tiles, grid);
  }

  // Test hook to force an immediate re-roll on the next decide() call.
  forceReroll(crawlerId: number): void {
    const ai = this.states.get(crawlerId);
    if (ai) ai.reevalInS = 0;
  }

  // Public for tests; called internally by decide() too. Returns the
  // chosen TaskKind for this bug's next task pick. Does NOT mutate
  // ai.currentTask — that's done by decide()'s task-switch bookkeeping
  // only when the pick actually changes.
  //
  // When called directly (e.g. from tests bypassing decide()), this also
  // performs a lightweight phase check from player proximity so eligibility
  // predicates that gate on ENGAGED behave correctly without a prior
  // decide() pass. decide() itself runs the full phase machinery upstream
  // before calling this, so the check is idempotent in that path.
  decideTask(
    c: CrawlerState,
    _dt: number,
    players: ReadonlyArray<PlayerState>,
    bugs: ReadonlyArray<CrawlerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): TaskKindValue {
    const ai = this.states.get(c.id)!;
    ai.lastBugPos = { x: c.x, y: c.y };

    // Lightweight phase check from detection (mirrors decide()'s entry
    // logic, sans timer ticking). Lets tests call decideTask standalone.
    const near = nearestPlayer(c, players);
    let effectiveR = ai.profile.detectionRadiusPx;
    if (ai.currentTask === TaskKind.SEARCH) effectiveR *= ai.profile.searchRadiusMult;
    if (ai.alertBonusInS > 0) effectiveR *= ai.profile.alertBonusMult;
    const detected = !!near && near.dist2 <= effectiveR * effectiveR;
    if (detected || ai.hasInvestigateTarget) {
      ai.phase = 'ENGAGED';
    }

    const eligible: { task: TaskKindValue; score: number }[] = [];
    for (const t of ai.profile.taskLibrary) {
      if (!this.isTaskEligibleFor(ai, ai.lastBugPos, t, players, tiles, grid)) continue;
      const raw = this.scoreTaskFor(ai, ai.lastBugPos, t, players, bugs, tiles, grid);
      if (!Number.isFinite(raw)) continue;
      const weighted = raw * ai.profile.taskWeights[t] * noise();
      eligible.push({ task: t, score: weighted });
    }

    if (eligible.length === 0) return TaskKind.IDLE;

    // Softmax sample.
    const m = Math.max(...eligible.map((e) => e.score));
    const exps = eligible.map((e) => Math.exp((e.score - m) / SCORE_SOFTMAX_TEMPERATURE));
    const total = exps.reduce((a, b) => a + b, 0);
    const r = Math.random() * total;
    let acc = 0;
    for (let i = 0; i < eligible.length; i++) {
      acc += exps[i]!;
      if (r <= acc) return eligible[i]!.task;
    }
    return eligible[eligible.length - 1]!.task;
  }

  private isTaskEligibleFor(
    ai: CrawlerAi,
    bug: { x: number; y: number },
    task: TaskKindValue,
    players: ReadonlyArray<PlayerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): boolean {
    const fakeBug: CrawlerState = {
      id: 0, x: bug.x, y: bug.y, facing: 0, hp: 1,
      targetCx: 0, targetCy: 0, ai: 0, windUpInS: 0,
    };
    const near = nearestPlayer(fakeBug, players);
    switch (task) {
      case TaskKind.SEEK_PLAYER:
        return ai.phase === 'ENGAGED' && !!near;
      case TaskKind.ATTACK_PLAYER:
        return ai.phase === 'ENGAGED' && !!near && near.dist2 <= ai.profile.meleeGapPx ** 2;
      case TaskKind.SEEK_TILE:
        return ai.phase === 'CALM'
          && this.findBestSeekTile(bug, ai.profile.seekTileRadiusPx, tiles, grid) !== null;
      case TaskKind.ATTACK_TILE: {
        const tcx = Math.floor(bug.x / grid.panelSize);
        const tcy = Math.floor(bug.y / grid.panelSize);
        if (tcx < 0 || tcx >= grid.cols || tcy < 0 || tcy >= grid.rows) return false;
        const idx = indexOf(grid.cols, tcx, tcy);
        const attackable = tiles.l1Hp[idx]! > 0 || tiles.l0Hp[idx]! > 0;
        return attackable && ai.attackRestInS === 0;
      }
      case TaskKind.SEARCH:
        return ai.phase === 'CALM';
      case TaskKind.INVESTIGATE:
        return ai.phase === 'ENGAGED' && ai.hasInvestigateTarget;
      case TaskKind.IDLE:
        return true;
      default:
        return false;
    }
  }

  private scoreTaskFor(
    ai: CrawlerAi,
    bug: { x: number; y: number },
    task: TaskKindValue,
    players: ReadonlyArray<PlayerState>,
    bugs: ReadonlyArray<CrawlerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): number {
    const profile = ai.profile;
    switch (task) {
      case TaskKind.SEEK_PLAYER:
      case TaskKind.ATTACK_PLAYER: {
        const fakeBug: CrawlerState = {
          id: 0, x: bug.x, y: bug.y, facing: 0, hp: 1,
          targetCx: 0, targetCy: 0, ai: 0, windUpInS: 0,
        };
        const crowd = countNearbyBugs(fakeBug, bugs, profile.crowdRadiusPx);
        const base = 100 - crowdPenalty(crowd);
        // T10: ATTACK_PLAYER strictly dominates SEEK_PLAYER when eligible.
        // Eligibility already gates ATTACK_PLAYER on being within meleeGapPx,
        // so by the time both tasks score we should commit the swing rather
        // than re-roll into a sibling chase via softmax. Bonus is many τ
        // (~17×) wide so the softmax (τ=30) collapses to a deterministic
        // pick even under worst-case noise.
        if (task === TaskKind.ATTACK_PLAYER) return base + 500;
        return base;
      }
      case TaskKind.SEEK_TILE: {
        const best = this.findBestSeekTile(bug, profile.seekTileRadiusPx, tiles, grid);
        return best ? best.score : -Infinity;
      }
      case TaskKind.ATTACK_TILE: {
        const tcx = Math.floor(bug.x / grid.panelSize);
        const tcy = Math.floor(bug.y / grid.panelSize);
        if (tcx < 0 || tcx >= grid.cols || tcy < 0 || tcy >= grid.rows) return -Infinity;
        const idx = indexOf(grid.cols, tcx, tcy);
        const l1 = tiles.l1Hp[idx]!;
        const l0 = tiles.l0Hp[idx]!;
        let score = -Infinity;
        if (l1 > 0) {
          score = profile.panelBase + profile.panelDamageScale * (1 - l1 / L1_PANEL_MAX_HP);
        } else if (l0 > 0) {
          score = profile.domeBase + profile.domeDamageScale * (1 - l0 / L0_DOME_MAX_HP);
        }
        if (Number.isFinite(score)) {
          // Exclude self from the active-attacker count: scoring my own
          // continuation of an attack shouldn't penalize me for being the
          // attacker. Both selfAttacking and activeAttackerCount() now read
          // ai.currentTask (the new TaskKind field) so the bookkeeping
          // stays consistent post-T8.
          const selfAttacking = ai.currentTask === TaskKind.ATTACK_TILE ? 1 : 0;
          const others = Math.max(0, this.activeAttackerCount() - selfAttacking);
          score -= ACTIVE_ATTACKER_PENALTY * others;
        }
        return score;
      }
      case TaskKind.SEARCH:
        return 30;
      case TaskKind.INVESTIGATE:
        return ai.hasInvestigateTarget ? 60 : -Infinity;
      case TaskKind.IDLE:
        return 5;
      default:
        return -Infinity;
    }
  }

  private findBestSeekTile(
    bug: { x: number; y: number },
    radiusPx: number,
    tiles: TileBuffers,
    grid: GridDef,
  ): { tx: number; ty: number; score: number } | null {
    const tilesAcross = Math.ceil(radiusPx / grid.panelSize);
    const cx = Math.floor(bug.x / grid.panelSize);
    const cy = Math.floor(bug.y / grid.panelSize);
    let best: { tx: number; ty: number; score: number } | null = null;
    for (let oy = -tilesAcross; oy <= tilesAcross; oy++) {
      for (let ox = -tilesAcross; ox <= tilesAcross; ox++) {
        const tx = cx + ox;
        const ty = cy + oy;
        if (tx < 0 || tx >= grid.cols || ty < 0 || ty >= grid.rows) continue;
        const idx = indexOf(grid.cols, tx, ty);
        const l1 = tiles.l1Hp[idx]!;
        const l0 = tiles.l0Hp[idx]!;
        let s = -Infinity;
        if (l1 > 0 && l1 < L1_PANEL_MAX_HP) {
          s = 1 + 15 * (1 - l1 / L1_PANEL_MAX_HP);
        } else if (l0 > 0 && l0 < L0_DOME_MAX_HP) {
          s = 25 + 35 * (1 - l0 / L0_DOME_MAX_HP);
        }
        if (Number.isFinite(s) && (best === null || s > best.score)) {
          best = { tx, ty, score: s };
        }
      }
    }
    return best;
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
