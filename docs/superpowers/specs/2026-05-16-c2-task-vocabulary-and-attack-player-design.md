# C2 — Task Vocabulary, Phase Model, and `ATTACK_PLAYER` State Machine

**Status:** design — implementation lands as C2 in `packages/server/src/CrawlerAi.ts`, `packages/shared/src/enemies/`.
**Predecessors:** C1 (layered tiles + binary chase/attack priority AI; commit `66314fd`).
**Successors:** C3 (player HP, swing→damage resolution, charged-shock VFX); future swarm-AI spec (CALL_ALERT emission + propagation tuning).

## Context

The C1 priority AI is a binary chooser: every reroll picks `CHASE_PLAYER` or `ATTACK_TILE` via softmax. In playtest this exposed three structural problems:

1. **Bugs that reach a pilot chew the floor under them.** `stepCrawler`'s CHASE arrival branch sets the bug's current-tile as `ATTACKING`, and weight integrity treats this identically to a real tile siege. The pilot is in mortal danger but feels like nothing's happening.
2. **The hard `PLAYER_AGGRO_RADIUS_PX` interrupt makes pilots a panel-rescue button.** A pilot walking past a row of attacking mites peels every one of them off, regardless of how invested each was in its tile. The intended flood-pressure (mites siege across the map, pilots have to scan and rotate) is undermined.
3. **The vocabulary is too small for the planned roster.** C2 already commits to mites being one of *several* future enemy classes (brute, burrower, etc.) expressed through the priority engine. Two task kinds is structurally inadequate — there's no place to put a bug that searches, investigates an alert, hangs idle, or path-prefers tunneled tiles.

This spec defines the C2 task vocabulary, the two-phase model that gates task eligibility, the per-enemy profile structure, the `ATTACK_PLAYER` state machine (wind-up → swing → recovery), and the wire format bump (schema v15). Swarm AI propagation is **scaffolded** here (data fields, alert reception handling) but the emission side and tuned propagation effects ship in their own follow-up spec.

The mite is the canonical and only enemy class for v1. The architecture is built so a future enemy lands as a new `EnemyProfile` record plus optional task-specific executor branches — not a rewrite.

## Goals

- Replace the binary task chooser with a **task vocabulary** (7 verbs) gated by a two-level hierarchical model (phase → task).
- Replace the on-pilot floor-chewing pattern with an explicit `ATTACK_PLAYER` task that runs a wind-up → swing → recovery loop. The swing is a no-op in C2; C3 wires it to player damage.
- Replace the hard pilot-proximity interrupt with **commitment-weighted soft aggro**: the longer a bug has been on `ATTACK_TILE`, the harder a passing pilot is to peel it off.
- Surface every bug-type tuning value (detection radius, melee gap, wind-up duration, task weights, etc.) on a single `EnemyProfile` record so future enemies are one struct, not a rewrite.
- Scaffold swarm-AI: per-bug alert-bonus field, phase transition on alert, INVESTIGATE task. Emission and propagation policy land in a follow-up spec.

## Non-goals

- Player HP, contact damage, swing→damage resolution (deferred to C3).
- Generalized swarm-AI propagation policy. The **mite** gets a mild propagation effect (emission on `SEEK_PLAYER` entry; receivers within `alertPropagationRadiusPx` get a phase flip + INVESTIGATE seed + temporary detection-radius bonus). A future swarm-AI spec adds more nuanced patterns (decayed re-broadcast, distance-attenuated bonus, kept-alive alert state, per-enemy-type propagation styles) when there are enemies that need them.
- Pathfinding beyond a `passageSpeedMult` speed boost through tunneled tiles. No A*. Bugs still move toward targets in straight lines (with the existing simple-collision behavior).
- New enemy types. Mite is the only profile.
- Spawn telegraphs / wave structure / city HP — those are C3 / C4.

## Task vocabulary

Seven task kinds, expressed as a flat enum on the wire and a discriminated union in TypeScript. Tasks are **intent** — what the bug is currently choosing to do. The bug's physical animation state (`CrawlerAIState`) is downstream and may collapse multiple tasks onto one state value (e.g., SEEK_PLAYER and SEEK_TILE both render as `APPROACHING`).

| Task | What it does | Eligibility | Commitment |
|---|---|---|---|
| `SEEK_PLAYER` | Walk toward the nearest detected pilot. Transitions to `ATTACK_PLAYER` at `meleeGapPx`. | Phase = ENGAGED; a pilot is within `detectionRadiusPx` (or recently was, within `engagedDecayS`). | 4 s commit window. |
| `ATTACK_PLAYER` | Wind-up → swing → recovery at melee gap of a chosen pilot. Latching: pilot movement does NOT cancel wind-up. | Phase = ENGAGED; bug is within `meleeGapPx` of a pilot. | Until recovery completes (wind-up + swing + recovery durations). |
| `SEEK_TILE` | Scan tiles within `seekTileRadiusPx`, pick one weighted by damage (more damaged = more attractive), walk toward it. Transitions to `ATTACK_TILE` on arrival. | Phase = CALM; an attackable tile exists within `seekTileRadiusPx`. | 4 s, or until arrival. |
| `ATTACK_TILE` | Chew the tile under the bug. (Unchanged from C1.) | Bug stands on a tile with `l1Hp > 0` or `l0Hp > 0` AND `attackRestInS == 0`. | Until tile destroyed. Soft-aggro shrinks pilot-detection while committed. |
| `SEARCH` | Wander with `detectionRadius × searchRadiusMult` (widened sensor). Random direction changes on a slow cadence. | Phase = CALM; no pilot detected. | 4 s commit window. |
| `INVESTIGATE` | Walk toward a specific point (alert source / disturbance origin). Stale-times out after `investigateStaleS`. | Phase = ENGAGED; bug has an unconsumed alert target. | Until arrival or stale. |
| `IDLE` | Stand still. Used between other tasks or for sluggish enemy archetypes. | Always eligible. | `idleDurS` (default 2 s). |

### Tile-target selection for `SEEK_TILE`

When a bug picks `SEEK_TILE`, the target is chosen at *task-entry* time, not every tick:

```
candidates = tiles within seekTileRadiusPx of the bug
score(t) = 1 + tileDamageScale × max(
              (1 - l1Hp/L1_PANEL_MAX_HP),    if L1 present
              (1 - l0Hp/L0_DOME_MAX_HP) + domeBias,  if L0 only
              0
           )
pick weighted-random by score (softmax across candidates)
```

This makes mites opportunistic — they drift toward already-damaged tiles rather than starting fresh on healthy panels.

### `INVESTIGATE` target lifecycle

`investigateTargetX/Y` is set when a `CALL_ALERT` is received from a peer (or, future, from a player-generated event). The target persists on the bug's AI state until consumed (arrival) or stale (`investigateStaleS` elapses since seeding). Multiple alerts overwrite the target (newest wins).

## Phase model

Each bug is in one of two phases. Phase determines task eligibility. Phase transitions are checked **every tick** (cheap — just predicate eval); task picks fire on `TASK_REEVAL_INTERVAL_S` (4 s).

```
       Phase: CALM                            Phase: ENGAGED
       ┌─────────────────────────┐            ┌──────────────────────────┐
       │  Eligible tasks:        │            │  Eligible tasks:         │
       │    SEEK_TILE            │            │    SEEK_PLAYER           │
       │    ATTACK_TILE          │            │    ATTACK_PLAYER         │
       │    SEARCH               │            │    INVESTIGATE           │
       │    IDLE                 │            │    IDLE                  │
       └─────────────────────────┘            └──────────────────────────┘
       (IDLE is always eligible; its low weight makes it mostly a CALM fallback.)
                  │                                       │
                  │  Triggers CALM → ENGAGED              │ Triggers ENGAGED → CALM
                  │  (any of):                            │ (after engagedDecayS s
                  │   - pilot within detectionRadius      │  of all of these):
                  │     × (searching ? searchRadiusMult)  │   - no pilot in detectionRadius
                  │   - CALL_ALERT received (also seeds   │   - no unconsumed alert target
                  │     INVESTIGATE target)               │   - not currently in
                  │   - bug takes damage                  │     ATTACK_PLAYER (wind-up etc.)
                  └───────────────────────────────────────┘
```

`searchRadiusMult` widens the very predicate that triggers `CALM → ENGAGED`. A SEARCHing bug is literally more likely to spot a pilot — the cost is the bug's exploring randomly, the benefit is faster detection. This is the explicit player-visible feedback loop described in the brainstorm.

Damage taken always flips `CALM → ENGAGED` regardless of detection. A pilot shocking a bug from across the map will aggro it (the bug knows where the damage came from for INVESTIGATE seeding — the player position at damage time).

## Enemy profile

A single immutable record per enemy class. Values are all surfaced here; no enemy-class behavior lives behind hardcoded constants in the AI manager.

```ts
interface EnemyProfile {
  // ─── Identity ────────────────────────────────────────────────────────
  readonly id: string;             // 'mite' | future 'brute' | …

  // ─── Detection ───────────────────────────────────────────────────────
  detectionRadiusPx: number;
  searchRadiusMult: number;        // SEARCH widens detection by this factor
  engagedDecayS: number;           // ENGAGED → CALM after this many seconds idle

  // ─── Movement ────────────────────────────────────────────────────────
  baseSpeedPx: number;
  passageSpeedMult: number;        // movement-speed multiplier on passage tiles

  // ─── Combat ──────────────────────────────────────────────────────────
  meleeGapPx: number;              // ATTACK_PLAYER engages at this gap
  windUpDurS: number;              // latching wind-up timer
  recoveryDurS: number;            // post-swing vulnerable window
  staggerThresholdHp: number;      // damage in staggerWindowS that breaks wind-up
  staggerWindowS: number;

  // ─── Tile interest ───────────────────────────────────────────────────
  panelBase: number;
  panelDamageScale: number;
  domeBase: number;
  domeDamageScale: number;
  seekTileRadiusPx: number;

  // ─── Task vocabulary ─────────────────────────────────────────────────
  taskLibrary: readonly TaskKind[];
  taskWeights: Readonly<Record<TaskKind, number>>;
  startTask: TaskKind;             // task assigned on spawn

  // ─── Swarm AI (scaffolded; emission ships in follow-up spec) ────────
  alertPropagationRadiusPx: number;
  alertBonusMult: number;          // detectionRadius multiplier while alerted
  alertBonusDurS: number;
  investigateStaleS: number;
}
```

### Mite profile defaults

```ts
const MITE_PROFILE: EnemyProfile = {
  id: 'mite',

  detectionRadiusPx: 160,           // ~2.5 tiles; was 192 hard radius in C1
  searchRadiusMult: 1.6,
  engagedDecayS: 8,

  baseSpeedPx: 80,                  // existing CRAWLER_MOVE_SPEED
  passageSpeedMult: 1.3,            // 30% faster through tunneled tiles

  meleeGapPx: 30,                   // PLAYER_RADIUS + CRAWLER_RADIUS + 4 slack
  windUpDurS: 0.6,
  recoveryDurS: 0.4,
  staggerThresholdHp: 2,            // dormant on HP=1 mites; future-proofs tougher bugs
  staggerWindowS: 0.5,

  panelBase: 5,
  panelDamageScale: 15,
  domeBase: 25,
  domeDamageScale: 35,
  seekTileRadiusPx: 192,            // 3 tiles

  taskLibrary: [
    'SEEK_PLAYER', 'ATTACK_PLAYER', 'SEEK_TILE', 'ATTACK_TILE',
    'SEARCH', 'INVESTIGATE', 'IDLE',
  ],
  taskWeights: {
    SEEK_PLAYER:   1.0,
    ATTACK_PLAYER: 1.0,             // base; eligibility gates it to melee range
    SEEK_TILE:     0.3,
    ATTACK_TILE:   0.5,             // the "opportunistic chew while passing through"
    SEARCH:        0.6,
    INVESTIGATE:   0.8,
    IDLE:          0.1,
  },
  startTask: 'SEEK_PLAYER',         // spawn primed to hunt; subject to first reroll

  alertPropagationRadiusPx: 128,    // 2 tiles
  alertBonusMult: 1.3,
  alertBonusDurS: 2.0,
  investigateStaleS: 10,
};
```

`taskWeights` is a flat multiplier on the per-task score pre-softmax. With `ATTACK_TILE` at 0.5 base weight and `SEEK_PLAYER` at 1.0, a mite that detects a pilot will overwhelmingly chase — but ~10–20 % of CALM rerolls in mid-map calm zones will still pick `SEEK_TILE` or `ATTACK_TILE`, producing the "occasional breachers across the map" pattern. This is the user-described "mites tend to be more opportunistic and prefer more damaged tiles."

## Selection mechanics

Each tick, per bug:

```
1. Update phase
   - Evaluate phase transition predicates.
   - If transitioning, reset phase-scoped state (e.g., chase commit, attack rest).

2. Run task commitment
   - Decrement any timers (windUpInS, recoveryInS, idleDurS, …).
   - If currently committed (chase commit window, attack-on-tile, wind-up,
     recovery, idle window) → continue current task.

3. Re-roll if reevalInS ≤ 0
   - Filter taskLibrary to tasks eligible in current phase AND meeting
     per-task condition.
   - For each eligible task t:
        rawScore(t) = baseScore(t, bug, world, profile)
        weighted(t) = rawScore(t) × taskWeights[t] × noise()
   - Softmax over weighted scores at τ = 30 (existing temperature), sample.
   - If picked task differs from current → enter new task; reset
     attentionPenalty, set commit timer, broadcast CALL_ALERT if task is
     SEEK_PLAYER (swarm AI hook).
```

Per-task `baseScore` functions are deliberately small:

- **`SEEK_PLAYER`**: `profile.panelMax = MITE_PROFILE.player - crowdPenalty(nearbyBugs)`. (Existing C1.9 formula.)
- **`ATTACK_PLAYER`**: same as SEEK_PLAYER (the gating is eligibility — only scored when at melee gap).
- **`SEEK_TILE`**: damage-weighted scan of tiles in `seekTileRadiusPx`; score is the best candidate's damage score.
- **`ATTACK_TILE`**: `panelBase + panelDamageScale × (1 - hp/max)`, layer-aware (panel vs dome). Subtracts `ACTIVE_ATTACKER_PENALTY × #attacking` (existing anti-pile-on). `-Infinity` while `attackRestInS > 0` (existing post-kill rest).
- **`SEARCH`**: flat profile value (e.g., 30) — search isn't graded by context, it's just an option.
- **`INVESTIGATE`**: flat ~60 if the bug has an unconsumed alert target, else `-Infinity`. Higher than SEARCH so alerts actually move the bug.
- **`IDLE`**: flat ~5 — the "do nothing" floor.

The softmax + per-task weight + noise produces:
- A mite in CALM with no nearby damaged tiles ≈ rolls between SEARCH (0.6 × ~30) and IDLE (0.1 × ~5) → SEARCH dominates.
- A mite in CALM near a half-dead panel → SEEK_TILE (0.3 × ~12) and ATTACK_TILE (0.5 × ~12 if standing on it) compete with SEARCH.
- A mite in ENGAGED → SEEK_PLAYER (1.0 × 100ish) overwhelmingly wins; INVESTIGATE wins if alerted but no detection yet; ATTACK_PLAYER wins at melee gap.

### Swarm-AI scaffold (mite has a mild propagation effect)

Emission and reception are both server-internal — nothing on the wire.

**Emission** (mite-only behaviour today):

```
When a bug transitions to SEEK_PLAYER as a NEW task (not on a re-pick
that keeps it on SEEK_PLAYER), broadcast a CALL_ALERT to every bug
within profile.alertPropagationRadiusPx of the alerter's position.
The alert carries (alerterX, alerterY).
```

**Reception** (every profile uses this; alert is a no-op if the profile's `alertBonusMult` is 1.0):

```
On CALL_ALERT(x, y):
  - if currentPhase = CALM → phase ← ENGAGED.
  - alertBonusInS ← profile.alertBonusDurS.
  - investigateTargetX/Y ← (x, y); investigateUntilS ← now + profile.investigateStaleS.
  - effectiveDetectionR is multiplied by profile.alertBonusMult while
    alertBonusInS > 0.
```

The mite ships with `alertBonusMult = 1.3` and `alertBonusDurS = 2.0`. The next swarm-AI spec will introduce richer patterns (re-broadcast attenuation, kept-alive alerts) and probably a few enemy profiles whose `alertBonusMult` is higher or whose propagation radius is much wider.

### Soft commitment-weighted aggro

Only `ATTACK_TILE` has a commitment-weighted effective detection radius (the soft peel-off the brainstorm called out):

```
effectiveDetectionR = detectionRadiusPx                         (default)
if currentTask = ATTACK_TILE:
  t = clamp(taskCommitmentS / attackCommitmentDecayS, 0, 1)
  effectiveDetectionR = detectionRadiusPx × (1 - t × (1 - attackCommitmentFloor))
```

With `attackCommitmentDecayS = 6.0` and `attackCommitmentFloor = 0.25`:
- Fresh attacker (0 s in): full 160 px radius — pilot peels it easily.
- 3 s in: ~100 px (~1.6 tiles).
- 6 s+ in: 40 px (~0.6 tile). Pilot must stand on top of the bug to peel it; otherwise it stays on the panel.

This is the C1.9 hard 192 px interrupt's replacement. Pilots use shock to disable mites in their personal space, not just presence.

## `ATTACK_PLAYER` state machine

Bug state during the task (`CrawlerAIState` enum values):

```
        SEEK_PLAYER (APPROACHING)
                │
                │ dist < meleeGapPx
                ▼
            WIND_UP                    ─── windUpInS = profile.windUpDurS
                │                          bug faces pilot at entry, FROZEN target
                │   each tick:
                │     windUpInS -= dt
                │     stagger check:
                │       if staggerAccumHp ≥ threshold → skip to RECOVERY
                │
                │ windUpInS ≤ 0
                ▼
           SWING (1-tick event)        ─── emits SwingFired signal in snapshot;
                │                          C2: no-op. C3: resolves player damage.
                │
                ▼
           RECOVERY                    ─── recoveryInS = profile.recoveryDurS
                │                          bug faces last swing direction, idle
                │                          incoming damage is NOT reduced
                │ recoveryInS ≤ 0
                ▼
          re-priority roll             ─── reevalInS = 0; runs normal task pick
```

**Stagger accumulator**: a per-bug `staggerAccumHp` is incremented when the bug takes damage. It decays toward 0 at `staggerAccumHp / staggerWindowS` per second so old hits don't accumulate indefinitely. When it crosses `staggerThresholdHp`, wind-up cancels (skipping the swing) and the bug enters RECOVERY. On HP=1 mites the bug dies before it can stagger; on future tougher enemies this gives players a tactical "interrupt the windup" loop.

**Wind-up is latching by design.** A pilot who walks away during wind-up does NOT cancel it — the bug swings into empty air, then enters RECOVERY anyway. This forces pilots to either kill the bug before its swing, stagger it with concentrated fire, or accept that the swing fires (and in C3, take the hit).

## Wire format (schema v15)

| Change | File |
|---|---|
| `SCHEMA_VERSION` 14 → 15 + changelog entry | `packages/shared/src/constants.ts` |
| `CrawlerAIState` enum: add `WIND_UP=3`, `RECOVERY=4`, `SEARCHING=5`, `IDLE=6` | `packages/shared/src/enemies/crawler.ts` |
| `CrawlerEncoder` adds `windUpInS` (u8 quantized over `[0, profile.windUpDurS]`; encoded as 0 when state ≠ WIND_UP) | `packages/shared/src/net/entities/CrawlerEncoder.ts` |
| (Tasks themselves are NOT on the wire — they're server-side intent. Only the resulting bug state is transmitted.) | — |

`INVESTIGATING` shares the `APPROACHING` state value on the wire: visually a directed walk that the client doesn't need to distinguish from `SEEK_PLAYER`'s walking phase. `SEARCHING` gets its own value because future sprites will distinguish "head looking around" idle-walk from purposeful approach.

`SwingFired` is a per-tick event embedded in the bug's snapshot delta (an "edge" — set when state transitions WIND_UP → RECOVERY). Encoded as a single bit on the bug; C2 doesn't react to it server-side, but the client uses it to play swing VFX.

## File-level impact map

| File | Change |
|---|---|
| `packages/shared/src/enemies/taskTypes.ts` *(new)* | `TaskKind` enum, `Task` discriminated union, eligibility/score function signatures |
| `packages/shared/src/enemies/profiles.ts` *(new)* | `EnemyProfile` interface, `MITE_PROFILE` constant |
| `packages/shared/src/enemies/crawler.ts` | Extend `CrawlerAIState` enum; `stepCrawler` gains branches for WIND_UP, RECOVERY, SEARCHING, IDLE |
| `packages/shared/src/net/entities/CrawlerEncoder.ts` | Add `windUpInS` u8 field, `swingFired` bit |
| `packages/shared/src/constants.ts` | Bump SCHEMA_VERSION to 15 + changelog; new tuning constants (`ATTACK_COMMITMENT_DECAY_S`, `ATTACK_COMMITMENT_FLOOR`) |
| `packages/server/src/CrawlerAi.ts` | Rewrite: hierarchical phase→task scoring, per-bug `taskCommitmentS`, alert reception scaffold, all task `baseScore` functions |
| `packages/server/src/Room.ts` | `applyWeightIntegrity` ignores bugs in WIND_UP / RECOVERY / SEARCHING / IDLE / APPROACHING-on-CHASE-arrival; `damageCrawlersOnTile` increments `staggerAccumHp`; phase-transition on damage |
| `packages/shared/src/enemies/crawler.test.ts` | Update existing CHASE-arrival test (now WIND_UP); add SEEK_TILE target-pick test; SEARCH widens detection test |
| `packages/server/src/test/crawler-ai.test.ts` *(new)* | Phase transitions (detect/alert/damage/decay); task eligibility per phase; soft-aggro commitment decay; wind-up latching; stagger interrupt |
| `packages/server/src/test/integrity.test.ts` | WIND_UP / RECOVERY bug contributes zero weight to its tile |
| `packages/shared/src/net/__tests__/wire.test.ts` (or local crawler encoder test) | `windUpInS` round-trip; new state values round-trip; schema v15 handshake |

## Verification

1. **Unit tests:** all listed in the file-impact map pass. Specifically:
   - `WIND_UP` bug contributes 0 weight across one tick.
   - Pilot walks past a 6 s-committed `ATTACK_TILE` bug 100 px away — bug does NOT peel.
   - Same scenario at 30 px — bug DOES peel.
   - Mite spawn → SEEK_PLAYER → reach pilot → WIND_UP → SWING (with 0.6 s windup) → RECOVERY → re-priority.
   - Mite in CALM near healthy panel rolls SEEK_TILE / SEARCH / IDLE in roughly the weights-predicted distribution (statistical test with a seeded RNG).
2. **Manual playtest** (`npm run dev`, two clients):
   - **Flood pressure test:** spawn ~15 mites, walk pilots through a row of attacking mites. Mites ≥5 s committed do not peel; pilots must fire shocks. Compare to C1.9 baseline (everyone peels).
   - **Catch-the-pilot test:** stand still and let a mite walk onto you. Bug stops adjacent (NOT on top), enters WIND_UP. Panel HP under feet does not decrement. Swing fires after ~0.6 s; bug enters visible RECOVERY pose for ~0.4 s; then resumes.
   - **Mid-map siege test:** verify mites occasionally peel from chase to attack a damaged tile mid-map (~10–20 % CALM-phase rolls, observed over 30 s). The pattern should read "background pressure across the map" rather than "everyone always chasing or everyone always sieging."
3. **Schema v15 handshake:** an old client gets the `Hello` schema-mismatch error rather than misdecoding.
4. **Debug HUD:** confirm CrawlerAIState shows the new state values when bugs are in their respective phases. Confirm `windUpInS` decrements visibly on WIND_UP bugs.

## Out of scope for this spec

- C3 player HP, contact damage, swing→damage resolution. `SwingFired` is server-side acknowledged but unused.
- Swarm AI emission policy (when bugs broadcast CALL_ALERT). The reception side and `alertBonus*` fields ship here; emission ships with its own spec along with whatever tuning we end up needing.
- Pathfinding (A*). `passageSpeedMult` is the only nod to tunnel-preference; straight-line motion otherwise.
- New enemy types (brute, burrower, etc.). They drop in as new `EnemyProfile` records using this spec's vocabulary; the priority engine and state machine cover their needs.
- Spawn telegraphs, wave structure, city HP, run-end states — all C3/C4.

## Open questions for implementation-time decisions

- Default for `attentionPerScan` (the per-task boredom accumulator from C1.9) — keep at 5, or tighten for the more granular task vocabulary? Defer to playtest.
- `idleDurS` — proposed 2 s, but mites at this profile will almost never pick IDLE (weight 0.1). Probably moot for v1.
- `noise()` envelope — currently ±15 %. Generalizes fine; revisit if a future enemy needs different randomness.
