# C2 Task Vocabulary & ATTACK_PLAYER Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary chase/attack priority AI with a 7-task vocabulary gated by a CALM/ENGAGED phase model, introduce an explicit `ATTACK_PLAYER` state machine (wind-up → swing → recovery) that fixes the on-pilot floor-chewing bug, and replace the hard pilot-proximity interrupt with commitment-weighted soft aggro.

**Architecture:** Hierarchical scoring — phase predicate per tick, task softmax per re-eval window. All per-enemy tuning lives on a single `EnemyProfile` record; mite is the only profile in v1. Wire format bump to v15 carries new `CrawlerAIState` values and a `windUpInS` field. Server-internal swarm-AI scaffold (CALL_ALERT emission on `SEEK_PLAYER` entry; receivers get phase flip + INVESTIGATE seed) ships with mite-only mild propagation tuning.

**Tech Stack:** TypeScript workspaces (`@gridforce/shared`, `@gridforce/server`). Node test runner. Existing binary wire codec.

**Spec:** `docs/superpowers/specs/2026-05-16-c2-task-vocabulary-and-attack-player-design.md`

---

## File structure

**New files (3):**
- `packages/shared/src/enemies/taskTypes.ts` — `TaskKind` enum and `Task` discriminated union
- `packages/shared/src/enemies/profiles.ts` — `EnemyProfile` interface and `MITE_PROFILE` constant
- `packages/server/src/test/crawler-ai.test.ts` — phase/task/wind-up behavior tests

**Modified files (7):**
- `packages/shared/src/constants.ts` — `SCHEMA_VERSION` 14→15 + tuning constants
- `packages/shared/src/types.ts` — extend `CrawlerAIState` enum; add `windUpInS` to `CrawlerState`
- `packages/shared/src/net/entities/CrawlerEncoder.ts` — encode/decode `windUpInS` as u8
- `packages/shared/src/enemies/crawler.ts` — `stepCrawler` branches for new states/tasks
- `packages/shared/src/enemies/crawler.test.ts` — update CHASE-arrival assertion
- `packages/shared/src/index.ts` — export new modules
- `packages/server/src/CrawlerAi.ts` — full rewrite around `EnemyProfile` + hierarchical scoring
- `packages/server/src/Room.ts` — `applyWeightIntegrity` exclusions; damage → stagger accumulator

---

## Task 1: Schema v15 bump + new `CrawlerAIState` values + `windUpInS` wire field

**Files:**
- Modify: `packages/shared/src/constants.ts` (SCHEMA_VERSION + changelog)
- Modify: `packages/shared/src/types.ts` (CrawlerAIState enum, CrawlerState struct)
- Modify: `packages/shared/src/net/entities/CrawlerEncoder.ts` (encode/decode windUpInS)
- Test: `packages/shared/src/net/__tests__/wire.test.ts` (round-trip)

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/net/__tests__/wire.test.ts` (locate the existing `CrawlerEncoder round-trips Crawler state` block; add new tests below it):

```typescript
import { CrawlerAIState } from '../../types.js';

test('CrawlerEncoder round-trips new AI state values (WIND_UP, RECOVERY, SEARCHING, IDLE)', () => {
  const states = [
    CrawlerAIState.WIND_UP,
    CrawlerAIState.RECOVERY,
    CrawlerAIState.SEARCHING,
    CrawlerAIState.IDLE,
  ];
  for (const aiState of states) {
    const w = new BinaryWriter();
    const c = {
      id: 42, x: 100, y: 200, facing: 0, hp: 1,
      targetCx: 1, targetCy: 2, ai: aiState, windUpInS: 0,
    };
    CrawlerEncoder.encode(w, c);
    const r = new BinaryReader(w.buffer());
    const decoded = CrawlerEncoder.decode(r);
    assert.equal(decoded.ai, aiState);
  }
});

test('CrawlerEncoder round-trips windUpInS quantized to ~10ms precision', () => {
  const w = new BinaryWriter();
  const c = {
    id: 1, x: 0, y: 0, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0,
    ai: CrawlerAIState.WIND_UP,
    windUpInS: 0.6, // mite's default windUpDurS
  };
  CrawlerEncoder.encode(w, c);
  const r = new BinaryReader(w.buffer());
  const decoded = CrawlerEncoder.decode(r);
  // Quantization is windUpInS * 100 → u8, so 0.6 → 60 → 0.60. Tolerance ~0.01.
  assert.ok(Math.abs(decoded.windUpInS - 0.6) < 0.02);
});

test('Schema version is 15', () => {
  assert.equal(SCHEMA_VERSION, 15);
});
```

Ensure `SCHEMA_VERSION` is imported at the top of the test file (it likely already is for the schema-mismatch test).

- [ ] **Step 2: Run test to verify it fails**

```
npm run -w @gridforce/shared test 2>&1 | tail -15
```

Expected: failures around `CrawlerAIState.WIND_UP is undefined`, schema version mismatch, and `windUpInS` not round-tripping (currently the encoder has no such field).

- [ ] **Step 3: Bump schema and extend the enum**

In `packages/shared/src/constants.ts`, find the schema changelog block. Add this entry just before `export const SCHEMA_VERSION = 14;` and bump the constant:

```typescript
//  v15: C2 priority AI. CrawlerAIState gains WIND_UP=3, RECOVERY=4,
//       SEARCHING=5, IDLE=6. CrawlerEncoder gains a u8 windUpInS field
//       (quantized at 100 units/second; ~10 ms resolution, max ~2.55 s)
//       so clients can render a charge-up bar over wind-up bugs.
export const SCHEMA_VERSION = 15;
```

In `packages/shared/src/types.ts`, replace the `CrawlerAIState` block:

```typescript
// Crawler AI state — wire-encoded as a u8.
export const CrawlerAIState = {
  APPROACHING: 0,
  ATTACKING: 1,
  TRANSITING: 2,
  WIND_UP: 3,
  RECOVERY: 4,
  SEARCHING: 5,
  IDLE: 6,
} as const;
export type CrawlerAIStateValue = (typeof CrawlerAIState)[keyof typeof CrawlerAIState];

export interface CrawlerState {
  id: number;       // u16
  x: number;        // px
  y: number;        // px
  facing: number;   // rad (quantized u8)
  hp: number;       // u8, default 1 in B1
  targetCx: number; // u8 column
  targetCy: number; // u8 row
  ai: CrawlerAIStateValue;
  // Seconds remaining on the wind-up timer. Only meaningful when ai is
  // WIND_UP; encoded as 0 otherwise. Wire-quantized at 100 units/s (u8
  // capacity 0..2.55 s).
  windUpInS: number;
}
```

- [ ] **Step 4: Add `windUpInS` to the encoder**

In `packages/shared/src/net/entities/CrawlerEncoder.ts`, replace the file body with the version that has the extra u8 byte:

```typescript
import type { CrawlerState, CrawlerAIStateValue } from '../../types.js';
import type { BinaryReader, BinaryWriter } from '../wire.js';
import { EntityType } from '../wire.js';
import type { EntityEncoder } from './PlayerEncoder.js';

const TWO_PI = Math.PI * 2;

function quantizeFacing(rad: number): number {
  let f = rad % TWO_PI;
  if (f < 0) f += TWO_PI;
  return Math.round((f / TWO_PI) * 256) & 0xff;
}
function unquantizeFacing(q: number): number {
  return (q / 256) * TWO_PI;
}

function quantizeWindUp(s: number): number {
  const q = Math.round(Math.max(0, s) * 100);
  return q > 0xff ? 0xff : q;
}
function unquantizeWindUp(q: number): number {
  return q / 100;
}

// Layout (12 bytes per Crawler):
//   u16 id        (2)
//   i16 x         (2)   px, rounded; world < 32768 px wide
//   i16 y         (2)   px, rounded
//   u8  facingQ   (1)   facing quantized 0..255
//   u8  hp        (1)
//   u8  targetCx  (1)   grid column (u8)
//   u8  targetCy  (1)   grid row (u8)
//   u8  ai        (1)   CrawlerAIState value
//   u8  windUpQ   (1)   wind-up seconds remaining × 100; 0 unless WIND_UP
export const CrawlerEncoder: EntityEncoder<CrawlerState> = {
  type: EntityType.Crawler,
  encode(w: BinaryWriter, c: CrawlerState): void {
    w.u16(c.id & 0xffff);
    w.i16(Math.round(c.x));
    w.i16(Math.round(c.y));
    w.u8(quantizeFacing(c.facing));
    w.u8(c.hp & 0xff);
    w.u8(c.targetCx & 0xff);
    w.u8(c.targetCy & 0xff);
    w.u8(c.ai & 0xff);
    w.u8(quantizeWindUp(c.windUpInS));
  },
  decode(r: BinaryReader): CrawlerState {
    const id = r.u16();
    const x = r.i16();
    const y = r.i16();
    const facing = unquantizeFacing(r.u8());
    const hp = r.u8();
    const targetCx = r.u8();
    const targetCy = r.u8();
    const ai = r.u8() as CrawlerAIStateValue;
    const windUpInS = unquantizeWindUp(r.u8());
    return { id, x, y, facing, hp, targetCx, targetCy, ai, windUpInS };
  },
};
```

- [ ] **Step 5: Initialize `windUpInS` everywhere `CrawlerState` is constructed**

Find every constructor of `CrawlerState` in the codebase:

```
grep -rn "id:.*nextCrawlerId\|ai: CrawlerAIState\." packages/ --include='*.ts'
```

Likely places to update:
- `packages/server/src/Room.ts` — `spawnCrawler` (or similar) — add `windUpInS: 0`.
- `packages/shared/src/enemies/crawler.ts` — every `return { ...c, ai: …, ... }`: these already spread `...c` so they preserve the field; no change needed if the original spawn includes it.
- Any tests that construct `CrawlerState` literals (panel-jump, integrity, shock, c1-integration) — append `windUpInS: 0`.

Run a typecheck to find missing initializations:

```
npm run typecheck 2>&1 | tail -20
```

Expected: TypeScript errors for every literal missing `windUpInS`. Add `windUpInS: 0` to each.

- [ ] **Step 6: Run all tests**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

Expected: all green, including the new `CrawlerEncoder round-trips` tests.

- [ ] **Step 7: Commit**

```
git add packages/shared/src/constants.ts packages/shared/src/types.ts packages/shared/src/net/entities/CrawlerEncoder.ts packages/shared/src/net/__tests__/wire.test.ts packages/server/src/Room.ts
git commit -m "wire: schema v15 — CrawlerAIState gains WIND_UP/RECOVERY/SEARCHING/IDLE + windUpInS field"
```

---

## Task 2: `TaskKind` enum + `Task` discriminated union

**Files:**
- Create: `packages/shared/src/enemies/taskTypes.ts`
- Modify: `packages/shared/src/index.ts` (export new module)
- Test: `packages/shared/src/enemies/taskTypes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/enemies/taskTypes.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskKind, type Task } from './taskTypes.js';

test('TaskKind has 7 v1 vocabulary values', () => {
  assert.equal(TaskKind.SEEK_PLAYER, 'SEEK_PLAYER');
  assert.equal(TaskKind.ATTACK_PLAYER, 'ATTACK_PLAYER');
  assert.equal(TaskKind.SEEK_TILE, 'SEEK_TILE');
  assert.equal(TaskKind.ATTACK_TILE, 'ATTACK_TILE');
  assert.equal(TaskKind.SEARCH, 'SEARCH');
  assert.equal(TaskKind.INVESTIGATE, 'INVESTIGATE');
  assert.equal(TaskKind.IDLE, 'IDLE');
});

test('Task discriminated union narrows by kind', () => {
  const t: Task = { kind: TaskKind.SEEK_PLAYER, targetX: 10, targetY: 20 };
  if (t.kind === TaskKind.SEEK_PLAYER) {
    // TypeScript should accept these accesses; the assertion is the value.
    assert.equal(t.targetX, 10);
    assert.equal(t.targetY, 20);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm run -w @gridforce/shared test 2>&1 | tail -5
```

Expected: module not found / TaskKind undefined.

- [ ] **Step 3: Create the new module**

Create `packages/shared/src/enemies/taskTypes.ts`:

```typescript
// V1 task vocabulary for the priority AI. Each task is an "intent" the AI
// manager assigns to a bug; the executor (stepCrawler) then drives the
// physical state machine (CrawlerAIState) toward that intent. See
// docs/superpowers/specs/2026-05-16-c2-task-vocabulary-and-attack-player-design.md
// for the per-task eligibility and scoring spec.
export const TaskKind = {
  SEEK_PLAYER:   'SEEK_PLAYER',
  ATTACK_PLAYER: 'ATTACK_PLAYER',
  SEEK_TILE:     'SEEK_TILE',
  ATTACK_TILE:   'ATTACK_TILE',
  SEARCH:        'SEARCH',
  INVESTIGATE:   'INVESTIGATE',
  IDLE:          'IDLE',
} as const;
export type TaskKindValue = (typeof TaskKind)[keyof typeof TaskKind];

export type Task =
  | { kind: typeof TaskKind.SEEK_PLAYER; targetX: number; targetY: number }
  | { kind: typeof TaskKind.ATTACK_PLAYER; targetPlayerId: number }
  | { kind: typeof TaskKind.SEEK_TILE; targetCx: number; targetCy: number }
  | { kind: typeof TaskKind.ATTACK_TILE; targetCx: number; targetCy: number }
  | { kind: typeof TaskKind.SEARCH; wanderTargetX: number; wanderTargetY: number }
  | { kind: typeof TaskKind.INVESTIGATE; targetX: number; targetY: number }
  | { kind: typeof TaskKind.IDLE };
```

- [ ] **Step 4: Export from the shared index**

In `packages/shared/src/index.ts`, append:

```typescript
export * from './enemies/taskTypes.js';
```

- [ ] **Step 5: Run test to verify it passes**

```
npm run -w @gridforce/shared test -- --grep TaskKind 2>&1 | tail -10
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```
git add packages/shared/src/enemies/taskTypes.ts packages/shared/src/enemies/taskTypes.test.ts packages/shared/src/index.ts
git commit -m "enemies: TaskKind enum + Task discriminated union (C2 v1 vocabulary)"
```

---

## Task 3: `EnemyProfile` interface + `MITE_PROFILE` constant

**Files:**
- Create: `packages/shared/src/enemies/profiles.ts`
- Modify: `packages/shared/src/index.ts` (export)
- Test: `packages/shared/src/enemies/profiles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/enemies/profiles.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { MITE_PROFILE } from './profiles.js';
import { TaskKind } from './taskTypes.js';

test('MITE_PROFILE has the expected v1 task library', () => {
  assert.deepEqual([...MITE_PROFILE.taskLibrary].sort(), [
    TaskKind.ATTACK_PLAYER,
    TaskKind.ATTACK_TILE,
    TaskKind.IDLE,
    TaskKind.INVESTIGATE,
    TaskKind.SEARCH,
    TaskKind.SEEK_PLAYER,
    TaskKind.SEEK_TILE,
  ].sort());
});

test('MITE_PROFILE.startTask is SEEK_PLAYER', () => {
  assert.equal(MITE_PROFILE.startTask, TaskKind.SEEK_PLAYER);
});

test('MITE_PROFILE.taskWeights has an entry for every library task', () => {
  for (const t of MITE_PROFILE.taskLibrary) {
    assert.ok(
      MITE_PROFILE.taskWeights[t] !== undefined,
      `taskWeights missing entry for ${t}`,
    );
  }
});

test('MITE_PROFILE.windUpDurS fits in u8 wire quantization (≤ 2.55 s)', () => {
  assert.ok(MITE_PROFILE.windUpDurS <= 2.55);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/shared test -- --grep MITE_PROFILE 2>&1 | tail -5
```

Expected: module not found.

- [ ] **Step 3: Create the profile module**

Create `packages/shared/src/enemies/profiles.ts`:

```typescript
import { TaskKind, type TaskKindValue } from './taskTypes.js';

// All per-enemy tuning lives here. v1 has one profile (mite); future
// enemy types are additional records following the same shape.
export interface EnemyProfile {
  readonly id: string;

  // ─── Detection ───────────────────────────────────────────────────────
  detectionRadiusPx: number;
  searchRadiusMult: number;
  engagedDecayS: number;

  // ─── Movement ────────────────────────────────────────────────────────
  baseSpeedPx: number;
  passageSpeedMult: number;

  // ─── Combat ──────────────────────────────────────────────────────────
  meleeGapPx: number;
  windUpDurS: number;
  recoveryDurS: number;
  staggerThresholdHp: number;
  staggerWindowS: number;

  // ─── Tile interest ───────────────────────────────────────────────────
  panelBase: number;
  panelDamageScale: number;
  domeBase: number;
  domeDamageScale: number;
  seekTileRadiusPx: number;

  // ─── Crowd / swarm-cohesion ──────────────────────────────────────────
  crowdRadiusPx: number;           // peer-count radius for crowdPenalty

  // ─── Task vocabulary ─────────────────────────────────────────────────
  taskLibrary: readonly TaskKindValue[];
  taskWeights: Readonly<Record<TaskKindValue, number>>;
  startTask: TaskKindValue;

  // ─── Swarm AI scaffold (mite default: mild propagation) ─────────────
  alertPropagationRadiusPx: number;
  alertBonusMult: number;
  alertBonusDurS: number;
  investigateStaleS: number;
}

export const MITE_PROFILE: EnemyProfile = {
  id: 'mite',

  detectionRadiusPx: 160,
  searchRadiusMult: 1.6,
  engagedDecayS: 8,

  baseSpeedPx: 80,
  passageSpeedMult: 1.3,

  meleeGapPx: 30,
  windUpDurS: 0.6,
  recoveryDurS: 0.4,
  staggerThresholdHp: 2,
  staggerWindowS: 0.5,

  panelBase: 5,
  panelDamageScale: 15,
  domeBase: 25,
  domeDamageScale: 35,
  seekTileRadiusPx: 192,

  crowdRadiusPx: 128,

  taskLibrary: [
    TaskKind.SEEK_PLAYER,
    TaskKind.ATTACK_PLAYER,
    TaskKind.SEEK_TILE,
    TaskKind.ATTACK_TILE,
    TaskKind.SEARCH,
    TaskKind.INVESTIGATE,
    TaskKind.IDLE,
  ],
  taskWeights: {
    [TaskKind.SEEK_PLAYER]:   1.0,
    [TaskKind.ATTACK_PLAYER]: 1.0,
    [TaskKind.SEEK_TILE]:     0.3,
    [TaskKind.ATTACK_TILE]:   0.5,
    [TaskKind.SEARCH]:        0.6,
    [TaskKind.INVESTIGATE]:   0.8,
    [TaskKind.IDLE]:          0.1,
  },
  startTask: TaskKind.SEEK_PLAYER,

  alertPropagationRadiusPx: 128,
  alertBonusMult: 1.3,
  alertBonusDurS: 2.0,
  investigateStaleS: 10,
};
```

- [ ] **Step 4: Export from the shared index**

In `packages/shared/src/index.ts`, append:

```typescript
export * from './enemies/profiles.js';
```

- [ ] **Step 5: Run test to verify it passes**

```
npm run -w @gridforce/shared test -- --grep MITE_PROFILE 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```
git add packages/shared/src/enemies/profiles.ts packages/shared/src/enemies/profiles.test.ts packages/shared/src/index.ts
git commit -m "enemies: EnemyProfile interface + MITE_PROFILE constant"
```

---

## Task 4: New tuning constants (commitment decay + softmax τ)

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add the new constants**

Append to `packages/shared/src/constants.ts` (near the existing C1 layered-tiles tuning block):

```typescript
// C2 priority-AI tuning that lives outside any single enemy profile —
// these apply uniformly across enemy types. Per-enemy values (windUpDurS,
// detectionRadiusPx, taskWeights, etc.) live on EnemyProfile.

// How often (seconds) a bug re-evaluates its task. Higher = stickier
// decisions; lower = floppier. C1.9 was 4 s; same default in C2.
export const TASK_REEVAL_INTERVAL_S = 4.0;

// Commit lock applied after switching INTO a chase task. Carryover from
// C1.9; ATTACK_PLAYER uses the wind-up/recovery timers, ATTACK_TILE
// commits until tile-destroyed.
export const CHASE_COMMIT_S = 4.0;

// Softmax temperature for task scoring. Lower = closer to argmax; higher
// = closer to uniform. τ=30 keeps a 95-point gap at ~3% probability for
// the lower-scoring task.
export const SCORE_SOFTMAX_TEMPERATURE = 30;

// Anti-pile-on penalty subtracted from ATTACK_TILE score per currently-
// attacking bug across the level. Carryover from C1.9.
export const ACTIVE_ATTACKER_PENALTY = 3;

// Post-kill rest window after an ATTACK_TILE completes — bug cannot pick
// another ATTACK_TILE for this many seconds. Carryover from C1.9.
export const POST_KILL_REST_S = 5.0;

// Commitment-weighted soft aggro for ATTACK_TILE. The longer a bug has
// been chewing, the smaller its effective detectionRadius for the
// purposes of being peeled to chase a passing pilot. Decays linearly
// from 1.0 (fresh) toward FLOOR (fully committed) over DECAY_S seconds.
export const ATTACK_COMMITMENT_DECAY_S = 6.0;
export const ATTACK_COMMITMENT_FLOOR = 0.25;

// Mite/per-task baseline attention penalty per re-roll the bug stays on
// the same task. C1.9 carryover.
export const ATTENTION_PER_SCAN = 5;
```

- [ ] **Step 2: Typecheck**

```
npm run typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add packages/shared/src/constants.ts
git commit -m "constants: C2 priority-AI tuning (commitment decay, softmax τ, reeval interval)"
```

---

## Task 5: Refactor `CrawlerAi` state shape (no behavior change yet)

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`

The C1.9 file is the starting point. This task widens the `CrawlerAi` per-bug state interface to hold the new fields (`phase`, `currentTask`, `taskCommitmentS`, timers, `staggerAccumHp`, etc.) and accepts an `EnemyProfile` at construction. Behavior is unchanged — we just plumb in the wider state.

- [ ] **Step 1: Read the current file end-to-end before editing**

```
cat packages/server/src/CrawlerAi.ts | wc -l
```

Confirm size (should be ~260 lines). Read it; understand the existing flow.

- [ ] **Step 2: Rewrite the file with the new state shape, preserving existing behavior**

Replace the contents of `packages/server/src/CrawlerAi.ts` with the new structure. The `decide()` method's external signature stays the same; the internals widen.

```typescript
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

type Phase = 'CALM' | 'ENGAGED';

// Per-bug AI state held by the manager. Bug position/hp lives on
// CrawlerState (wire-visible); everything here is server-internal.
interface CrawlerAi {
  profile: EnemyProfile;
  phase: Phase;
  currentTask: TaskKindValue;
  // Current task's bound target data (extracted into the executor as a
  // CrawlerTask when stepCrawler is called).
  taskTargetX: number;
  taskTargetY: number;
  taskTargetCx: number;
  taskTargetCy: number;

  // Timers
  reevalInS: number;
  chaseCommitInS: number;
  attackRestInS: number;
  taskCommitmentS: number;       // time on current task (resets on switch)
  attentionPenalty: number;

  // ATTACK_PLAYER state machine
  windUpInS: number;
  recoveryInS: number;
  swingFiredThisTick: boolean;
  attackTargetPlayerId: number | null;

  // Stagger accumulator
  staggerAccumHp: number;
  staggerAccumS: number;          // time since last damage tick; for decay

  // Swarm-AI alert state
  alertBonusInS: number;
  investigateTargetX: number;
  investigateTargetY: number;
  investigateUntilS: number;
  hasInvestigateTarget: boolean;
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
  };
}

export class CrawlerAiManager {
  private states = new Map<number, CrawlerAi>();

  // Called by Room when an enemy spawns. C2 uses MITE_PROFILE for all
  // crawlers; future enemy types will dispatch by their own profiles.
  registerCrawler(id: number, profile: EnemyProfile = MITE_PROFILE): void {
    this.states.set(id, makeAiState(profile));
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
      // Defensive: a crawler that wasn't pre-registered (e.g., loaded from
      // a snapshot in a future replay system) gets the mite profile.
      ai = makeAiState(MITE_PROFILE);
      this.states.set(c.id, ai);
    }

    // Tick all timers.
    ai.reevalInS -= dt;
    ai.chaseCommitInS = Math.max(0, ai.chaseCommitInS - dt);
    ai.attackRestInS = Math.max(0, ai.attackRestInS - dt);
    ai.taskCommitmentS += dt;
    ai.alertBonusInS = Math.max(0, ai.alertBonusInS - dt);
    ai.staggerAccumS += dt;
    if (ai.staggerAccumS >= ai.profile.staggerWindowS) {
      ai.staggerAccumHp = 0;
      ai.staggerAccumS = 0;
    }

    // TEMPORARY: defer to the existing binary scoring until later tasks
    // wire the new task selection in. This preserves C1.9 behavior while
    // the state shape gets plumbed. The remaining tasks in this plan
    // replace this block with hierarchical phase→task scoring.
    return this.legacyDecide(c, ai, dt, players, bugs, tiles, grid);
  }

  // Preserved C1.9 logic — gets removed once the new path is wired in.
  // Inline here so existing tests keep passing during the refactor.
  private legacyDecide(
    c: CrawlerState,
    ai: CrawlerAi,
    dt: number,
    players: ReadonlyArray<PlayerState>,
    bugs: ReadonlyArray<CrawlerState>,
    tiles: TileBuffers,
    grid: GridDef,
  ): CrawlerTask {
    // ... copy the C1.9 decide() body here, but reading/writing the new
    // CrawlerAi fields. Specifically:
    //   - ai.task → ai.currentTask (translate via task → kind helpers
    //     below)
    //   - ai.attentionPenalty unchanged
    //   - ai.reevalInS unchanged
    //   - ai.chaseCommitInS unchanged
    //   - ai.attackRestInS unchanged
    //
    // Return value: CrawlerTask (existing shared type — kind is the C1
    // CrawlerTaskKind, NOT the new TaskKind). The new selection logic in
    // later tasks emits Task (new) and converts to CrawlerTask only at
    // the executor boundary.
    //
    // For brevity, see the C1.9 file you're replacing. The structural
    // change is `ai.task.kind === CrawlerTaskKind.X` → `ai.currentTask
    // === TaskKind.X` (where TaskKind values are strings); update
    // accordingly.

    // Stub: identical-behavior wrapper. Translate currentTask back to a
    // CrawlerTask for the executor.
    const target = nearestPlayer(c, players);
    if (ai.currentTask === TaskKind.ATTACK_TILE) {
      return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: ai.taskTargetCx, targetCy: ai.taskTargetCy };
    }
    if (target) {
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: target.x, targetY: target.y };
    }
    return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: ai.taskTargetCx, targetCy: ai.taskTargetCy };
  }

  remove(id: number): void {
    this.states.delete(id);
  }

  clear(): void {
    this.states.clear();
  }

  // Hook for Room: damage taken increments stagger accumulator and seeds
  // an INVESTIGATE target (the pilot who shot us). Phase transition to
  // ENGAGED is handled in Task 6.
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

function nearestPlayer(c: CrawlerState, players: ReadonlyArray<PlayerState>): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD2 = Infinity;
  for (const p of players) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best;
}
```

**IMPORTANT:** the `legacyDecide` stub above is intentionally minimal so the typecheck passes. **Copy the actual C1.9 `decide()` body and per-task scoring** from the file you're replacing — only swap the `ai.task.kind` references to `ai.currentTask` (with the TaskKind translation) and remove dead references to fields that no longer exist. The behavior must match C1.9 exactly after this task (existing tests must pass).

- [ ] **Step 3: Register every spawned crawler with the manager**

In `packages/server/src/Room.ts`, find `spawnCrawler` (or the equivalent method that adds a crawler to `this.crawlers`). Add a call:

```typescript
this.crawlerAi.registerCrawler(id, MITE_PROFILE);
```

right after the `this.crawlers.set(id, ...)` line. Import `MITE_PROFILE` from `@gridforce/shared`.

- [ ] **Step 4: Typecheck + run all tests**

```
npm run typecheck 2>&1 | tail -5
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

Expected: all green. Behavior is unchanged from C1.9.

- [ ] **Step 5: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/Room.ts
git commit -m "ai: widen CrawlerAi state shape for C2 phase/task fields (no behavior change)"
```

---

## Task 6: Phase transitions (CALM ↔ ENGAGED)

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`
- Test: `packages/server/src/test/crawler-ai.test.ts` (new file)

- [ ] **Step 1: Create the new test file**

Create `packages/server/src/test/crawler-ai.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MITE_PROFILE,
  allocateTiles,
  type CrawlerState,
  type PlayerState,
} from '@gridforce/shared';
import { CrawlerAiManager } from '../CrawlerAi.js';

const GRID = { cols: 10, rows: 10, panelSize: 64 };

function newBug(id: number, x: number, y: number): CrawlerState {
  return {
    id, x, y, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0,
    ai: 0, windUpInS: 0,
  };
}
function newPlayer(id: number, x: number, y: number): PlayerState {
  return {
    id, x, y, facing: 0, facingCursorRad: 0,
    panelJumpCooldownS: 0, stateSeq: 0,
    name: '', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0, shockHeldS: 0,
  };
}

test('phase: bug starts CALM with no players nearby', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'CALM');
});

test('phase: player inside detectionRadius flips CALM → ENGAGED', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  // Player 100 px away, well within the 160 px detection radius.
  const player = newPlayer(0, 420, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
});

test('phase: player leaves detection — ENGAGED → CALM after engagedDecayS', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  // Enter ENGAGED first.
  mgr.decide(bug, 0.016, [newPlayer(0, 420, 320)], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
  // Player gone. Tick enough to exceed engagedDecayS (8 s default).
  for (let t = 0; t < 9; t += 0.5) {
    mgr.decide(bug, 0.5, [], [bug], tiles, GRID);
  }
  assert.equal(mgr.getPhase(1), 'CALM');
});

test('phase: damage taken flips CALM → ENGAGED and seeds INVESTIGATE target', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  // No player nearby.
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'CALM');
  // Damage from a remote source.
  mgr.onDamageTaken(1, 1, 600, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
  const target = mgr.getInvestigateTarget(1);
  assert.ok(target);
  assert.equal(target!.x, 600);
  assert.equal(target!.y, 320);
});
```

- [ ] **Step 2: Run tests to verify failure**

```
npm run -w @gridforce/server test -- --grep "phase:" 2>&1 | tail -10
```

Expected: `getPhase` / `getInvestigateTarget` methods don't exist; tests fail.

- [ ] **Step 3: Implement phase transition + accessor methods**

In `packages/server/src/CrawlerAi.ts`, add to `CrawlerAiManager`:

```typescript
// Test/debug accessor.
getPhase(crawlerId: number): Phase | null {
  return this.states.get(crawlerId)?.phase ?? null;
}

// Test/debug accessor for INVESTIGATE target.
getInvestigateTarget(crawlerId: number): { x: number; y: number } | null {
  const ai = this.states.get(crawlerId);
  if (!ai || !ai.hasInvestigateTarget) return null;
  return { x: ai.investigateTargetX, y: ai.investigateTargetY };
}
```

In `decide()`, before the legacyDecide call, compute phase transitions:

```typescript
const near = nearestPlayer(c, players);

// Detection radius depends on current task (SEARCH widens) and alert
// bonus (CALL_ALERT receivers get a temporary boost).
let effectiveR = ai.profile.detectionRadiusPx;
if (ai.currentTask === TaskKind.SEARCH) effectiveR *= ai.profile.searchRadiusMult;
if (ai.alertBonusInS > 0) effectiveR *= ai.profile.alertBonusMult;
const effectiveR2 = effectiveR * effectiveR;

const detected = !!near && (
  (near.x - c.x) ** 2 + (near.y - c.y) ** 2 <= effectiveR2
);

// CALM → ENGAGED: detection, alert, or recent damage (already-seeded
// investigate target = damage was taken this window).
if (ai.phase === 'CALM') {
  if (detected || ai.hasInvestigateTarget) {
    ai.phase = 'ENGAGED';
    ai.engagedIdleS = 0;
  }
}

// ENGAGED → CALM: only after engagedDecayS seconds without detection,
// alert target, or active wind-up/recovery.
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
```

Add the `engagedIdleS` field to the `CrawlerAi` interface and initialize it to `0` in `makeAiState()`.

- [ ] **Step 4: Run the new tests**

```
npm run -w @gridforce/server test -- --grep "phase:" 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 5: Run all tests to confirm no regression**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

Expected: all green.

- [ ] **Step 6: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "ai: phase transitions (CALM ↔ ENGAGED) driven by detection, damage, decay"
```

---

## Task 7: Per-task eligibility predicates + base scoring functions

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`
- Test: `packages/server/src/test/crawler-ai.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/test/crawler-ai.test.ts`:

```typescript
test('eligibility: SEEK_PLAYER eligible only in ENGAGED phase with a player', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  // CALM phase — should NOT be eligible.
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.ok(!mgr.isTaskEligible(1, 'SEEK_PLAYER', [], tiles, GRID));
  // Bring a player into range to enter ENGAGED.
  const player = newPlayer(0, 420, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.ok(mgr.isTaskEligible(1, 'SEEK_PLAYER', [player], tiles, GRID));
});

test('eligibility: ATTACK_PLAYER eligible only at meleeGapPx', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  // Player too far for melee.
  let player = newPlayer(0, 400, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.ok(!mgr.isTaskEligible(1, 'ATTACK_PLAYER', [player], tiles, GRID));
  // Player within meleeGapPx (30).
  player = newPlayer(0, 340, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.ok(mgr.isTaskEligible(1, 'ATTACK_PLAYER', [player], tiles, GRID));
});

test('score: ATTACK_TILE on a healthy panel returns ~panelBase', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  const score = mgr.scoreTask(1, 'ATTACK_TILE', [], [bug], tiles, GRID);
  // panelBase=5, fully healthy → score is exactly 5 (no damage scaling).
  // Active-attacker penalty subtracts 0 (no attackers yet).
  assert.ok(Math.abs(score - 5) < 0.001);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "eligibility:\|score:" 2>&1 | tail -10
```

Expected: methods undefined.

- [ ] **Step 3: Implement eligibility + score helpers**

In `packages/server/src/CrawlerAi.ts`, add to `CrawlerAiManager`:

```typescript
isTaskEligible(
  crawlerId: number,
  task: TaskKindValue,
  players: ReadonlyArray<PlayerState>,
  tiles: TileBuffers,
  grid: GridDef,
): boolean {
  const ai = this.states.get(crawlerId);
  if (!ai) return false;
  // Find the bug's CrawlerState in the world. Manager doesn't keep
  // position, so accept it via the bug-aware methods that take a
  // CrawlerState parameter. For test ergonomics, accept "self" via
  // a separate isTaskEligibleFor method when called with the bug state
  // available. Here, infer from cached position via the AI's last
  // observed bug position (we cache it during decide()).
  if (!ai.lastBugPos) return false;
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

private isTaskEligibleFor(
  ai: CrawlerAi,
  bug: { x: number; y: number },
  task: TaskKindValue,
  players: ReadonlyArray<PlayerState>,
  tiles: TileBuffers,
  grid: GridDef,
): boolean {
  const near = nearestPlayer({ ...bug, id: 0, facing: 0, hp: 1, targetCx: 0, targetCy: 0, ai: 0, windUpInS: 0 }, players);
  switch (task) {
    case TaskKind.SEEK_PLAYER:
      return ai.phase === 'ENGAGED' && !!near;
    case TaskKind.ATTACK_PLAYER: {
      if (ai.phase !== 'ENGAGED' || !near) return false;
      const d2 = (near.x - bug.x) ** 2 + (near.y - bug.y) ** 2;
      return d2 <= ai.profile.meleeGapPx ** 2;
    }
    case TaskKind.SEEK_TILE: {
      if (ai.phase !== 'CALM') return false;
      // Need at least one attackable tile in seekTileRadiusPx.
      return this.findBestSeekTile(bug, ai.profile.seekTileRadiusPx, tiles, grid) !== null;
    }
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
      // Chase/melee share the score — eligibility gates ATTACK_PLAYER
      // to melee range. Existing C1.9 formula: 100 - crowdPenalty.
      const crowd = countNearbyBugs(bug, bugs, profile.crowdRadiusPx);
      return 100 - crowdPenalty(crowd);
    }
    case TaskKind.SEEK_TILE: {
      const best = this.findBestSeekTile(bug, profile.seekTileRadiusPx, tiles, grid);
      return best ? best.score : -Infinity;
    }
    case TaskKind.ATTACK_TILE: {
      const tcx = Math.floor(bug.x / grid.panelSize);
      const tcy = Math.floor(bug.y / grid.panelSize);
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
        score -= ACTIVE_ATTACKER_PENALTY * this.activeAttackerCount();
      }
      return score;
    }
    case TaskKind.SEARCH:
      return 30;
    case TaskKind.INVESTIGATE:
      return ai.hasInvestigateTarget ? 60 : -Infinity;
    case TaskKind.IDLE:
      return 5;
  }
}

// SEEK_TILE target picker: scan tiles in radius around bug, pick the
// best damage-weighted candidate. Returns {tx, ty, score} or null.
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
        s = 1 + 15 * (1 - l1 / L1_PANEL_MAX_HP); // local panelDamageScale weight
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

private activeAttackerCount(): number {
  let n = 0;
  for (const ai of this.states.values()) {
    if (ai.currentTask === TaskKind.ATTACK_TILE) n++;
  }
  return n;
}
```

Add the `lastBugPos: { x: number; y: number } | null` field to `CrawlerAi`, initialize to `null`. In `decide()`, set `ai.lastBugPos = { x: c.x, y: c.y };` at the start. Also add `crowdRadiusPx: 128` to the `EnemyProfile` interface and `MITE_PROFILE`.

Move the `crowdPenalty` and `countNearbyBugs` helpers from the C1.9 file into module-scope; they were already there.

- [ ] **Step 4: Run the new tests**

```
npm run -w @gridforce/server test -- --grep "eligibility:\|score:" 2>&1 | tail -10
```

Expected: 3 tests pass.

- [ ] **Step 5: Confirm no regression**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 6: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/test/crawler-ai.test.ts packages/shared/src/enemies/profiles.ts
git commit -m "ai: task eligibility predicates + base score functions"
```

---

## Task 8: Hierarchical task selection (filter → score → softmax → sample)

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`
- Test: `packages/server/src/test/crawler-ai.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test('selection: lone mite in ENGAGED with a nearby pilot picks SEEK_PLAYER >90% of rolls', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  // Force ENGAGED.
  const player = newPlayer(0, 420, 320);
  const bug = newBug(1, 320, 320);

  let chases = 0;
  for (let i = 0; i < 200; i++) {
    // Reset reeval each iteration so we re-pick every call.
    mgr.forceReroll(1);
    const task = mgr.decideTask(bug, 0.016, [player], [bug], tiles, GRID);
    if (task === 'SEEK_PLAYER') chases++;
  }
  assert.ok(chases > 180, `expected >180 chases, got ${chases}`);
});

test('selection: lone mite in CALM near no damaged tiles favours SEARCH', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);

  const counts: Record<string, number> = {};
  for (let i = 0; i < 200; i++) {
    mgr.forceReroll(1);
    const task = mgr.decideTask(bug, 0.016, [], [bug], tiles, GRID);
    counts[task] = (counts[task] ?? 0) + 1;
  }
  // Healthy panels, no players → SEARCH should dominate IDLE.
  assert.ok((counts['SEARCH'] ?? 0) > (counts['IDLE'] ?? 0));
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "selection:" 2>&1 | tail -5
```

Expected: `decideTask` / `forceReroll` undefined.

- [ ] **Step 3: Implement hierarchical selection + helpers**

In `packages/server/src/CrawlerAi.ts`:

```typescript
// Test-only hook to bypass the reeval window.
forceReroll(crawlerId: number): void {
  const ai = this.states.get(crawlerId);
  if (ai) ai.reevalInS = 0;
}

// New shape: returns the picked TaskKind. Used by decide() internally
// and exposed for tests.
decideTask(
  c: CrawlerState,
  dt: number,
  players: ReadonlyArray<PlayerState>,
  bugs: ReadonlyArray<CrawlerState>,
  tiles: TileBuffers,
  grid: GridDef,
): TaskKindValue {
  const ai = this.states.get(c.id)!;
  ai.lastBugPos = { x: c.x, y: c.y };

  // … phase transitions (already added in Task 6) …

  // Filter library by eligibility.
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
```

Wire `decideTask` into `decide()`. Replace the `legacyDecide(...)` call with logic that:

1. If timers/commit say "keep current task", reuse `ai.currentTask`.
2. Otherwise, call `decideTask`. If returned task != `ai.currentTask`, do task-switch bookkeeping (reset attentionPenalty, set chaseCommitInS / attackRestInS appropriately, reset taskCommitmentS = 0).
3. Convert the chosen `TaskKindValue` to the executor's `CrawlerTask` shape and return.

The CrawlerTask conversion is:

```typescript
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
      const near = nearestPlayer({ ...bug, id: 0, facing: 0, hp: 1, targetCx: 0, targetCy: 0, ai: 0, windUpInS: 0 }, players);
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: near?.x ?? bug.x, targetY: near?.y ?? bug.y };
    }
    case TaskKind.SEEK_TILE: {
      return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: ai.taskTargetCx, targetCy: ai.taskTargetCy };
    }
    case TaskKind.ATTACK_TILE: {
      const tcx = Math.floor(bug.x / grid.panelSize);
      const tcy = Math.floor(bug.y / grid.panelSize);
      return { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: tcx, targetCy: tcy };
    }
    case TaskKind.SEARCH:
    case TaskKind.INVESTIGATE:
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: ai.taskTargetX, targetY: ai.taskTargetY };
    case TaskKind.IDLE:
      return { kind: CrawlerTaskKind.CHASE_PLAYER, targetX: bug.x, targetY: bug.y };
  }
}
```

**NOTE:** the SEEK_TILE/SEARCH/INVESTIGATE/IDLE branches use `CHASE_PLAYER` shape temporarily — the executor only knows two task kinds today. Task 10+ adds new executor branches.

- [ ] **Step 4: Run the new tests**

```
npm run -w @gridforce/server test -- --grep "selection:" 2>&1 | tail -10
```

Expected: 2 tests pass.

- [ ] **Step 5: Run all tests**

Some C1 integration tests may now show different behavior (more variety in task picks). Inspect failures:

```
npm test 2>&1 | grep -B 2 "fail\|FAIL" | head -40
```

Expected failures: `c1-integration.test.ts` may have assertions on specific bug behavior. Update assertions if they're too tight (e.g., they assert ALL bugs chase; now ~3 % might not). Document the change in the commit.

- [ ] **Step 6: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/test/crawler-ai.test.ts packages/server/src/test/c1-integration.test.ts
git commit -m "ai: hierarchical task selection (phase filter + softmax over eligible tasks)"
```

---

## Task 9: `SEEK_PLAYER` → `WIND_UP` transition (stop short at melee gap, no tile damage)

**Files:**
- Modify: `packages/shared/src/enemies/crawler.ts`
- Modify: `packages/shared/src/types.ts` (extend CrawlerTask union if needed)
- Modify: `packages/shared/src/enemies/crawler.test.ts` (update CHASE-arrival assertion)
- Test: extend `packages/shared/src/enemies/crawler.test.ts`

- [ ] **Step 1: Update the existing CHASE-arrival test**

In `packages/shared/src/enemies/crawler.test.ts`, find the test `'CHASE stops and ATTACKS when on top of the target'`. Replace its assertion:

```typescript
test('CHASE arrival within meleeGap transitions to WIND_UP, not ATTACKING', () => {
  // The bug stands one tick from the player; CHASE should resolve to
  // WIND_UP at the next step (because dist < meleeGapPx).
  const c: CrawlerState = {
    id: 1, x: 332, y: 320, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.APPROACHING,
    windUpInS: 0,
  };
  const task: CrawlerTask = {
    kind: CrawlerTaskKind.CHASE_PLAYER, targetX: 320, targetY: 320,
  };
  const grid: GridDef = { cols: 10, rows: 10, panelSize: 64 };
  const next = stepCrawler(c, task, 0.016, grid, { tiles: allocateTiles(10, 10) });
  assert.equal(next.ai, CrawlerAIState.WIND_UP);
  // windUpInS should be set to the mite's default 0.6 s.
  assert.ok(Math.abs(next.windUpInS - 0.6) < 0.01);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/shared test -- --grep "WIND_UP" 2>&1 | tail -10
```

Expected: `stepCrawler` still returns `ATTACKING`.

- [ ] **Step 3: Update `stepCrawler` CHASE branch**

Replace the CHASE arrival block in `packages/shared/src/enemies/crawler.ts`:

```typescript
import { CRAWLER_MOVE_SPEED, MITE_PROFILE } from '../constants.js';
// … (also bring MITE_PROFILE in scope if not already)

// CHASE.
const dx = task.targetX - c.x;
const dy = task.targetY - c.y;
const dist = Math.hypot(dx, dy);

// Arrival check: within meleeGapPx → enter WIND_UP. The executor doesn't
// know which profile the bug belongs to (that's manager-side), so we
// rely on the manager to have set ai.windUpInS to profile.windUpDurS in
// the same tick the task switches. As a fallback we use the mite's
// melee gap and default windup duration — these are the only enemy in
// v1 so the fallback is exact for now.
const meleeGap = MITE_PROFILE.meleeGapPx;
if (dist < meleeGap) {
  return {
    ...c,
    ai: CrawlerAIState.WIND_UP,
    facing: Math.atan2(dy, dx),
    windUpInS: MITE_PROFILE.windUpDurS,
  };
}
```

**NOTE:** For C2 v1 the executor reads `MITE_PROFILE` directly. When a second enemy profile ships, the executor will need to receive the profile (extend `CrawlerStepContext` to include `profile: EnemyProfile`). Out of scope for this task.

- [ ] **Step 4: Run tests**

```
npm run -w @gridforce/shared test -- --grep "WIND_UP\|CHASE" 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 5: Run all tests**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

C1 integration tests may need re-tuning — pilots no longer take damage from bugs chewing under them (good); some assertions might be stale.

- [ ] **Step 6: Commit**

```
git add packages/shared/src/enemies/crawler.ts packages/shared/src/enemies/crawler.test.ts
git commit -m "executor: CHASE arrival within meleeGap → WIND_UP (no floor chewing)"
```

---

## Task 10: WIND_UP timer + SWING fire + RECOVERY transition

**Files:**
- Modify: `packages/shared/src/enemies/crawler.ts` (stepCrawler executor)
- Modify: `packages/server/src/Room.ts` (drive windUpInS / recoveryInS countdown)
- Modify: `packages/server/src/CrawlerAi.ts` (state machine bookkeeping)
- Test: `packages/server/src/test/crawler-ai.test.ts` (new test)

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/test/crawler-ai.test.ts`:

```typescript
test('wind-up: windUpInS counts down each tick', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  // Start the bug already at melee gap so first decide() enters WIND_UP.
  const bug = newBug(1, 332, 320);
  const player = newPlayer(0, 320, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  // After one decide, bug should be in ATTACK_PLAYER task → WIND_UP state.
  const first = mgr.getInternalAi(1)!;
  const wind1 = first.windUpInS;
  assert.ok(wind1 > 0);

  // Tick again — windUpInS decreases.
  mgr.decide(bug, 0.1, [player], [bug], tiles, GRID);
  const wind2 = mgr.getInternalAi(1)!.windUpInS;
  assert.ok(wind2 < wind1, `expected wind2 < wind1; got ${wind2} >= ${wind1}`);
});

test('wind-up: timer expiring fires SWING and transitions to RECOVERY', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 332, 320);
  const player = newPlayer(0, 320, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  // Fast-forward through the wind-up.
  for (let t = 0; t < 1.0; t += 0.05) {
    mgr.decide(bug, 0.05, [player], [bug], tiles, GRID);
  }
  const ai = mgr.getInternalAi(1)!;
  assert.ok(ai.recoveryInS > 0, `bug should be in RECOVERY; recoveryInS=${ai.recoveryInS}`);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "wind-up:" 2>&1 | tail -10
```

Expected: fails (no state machine wired yet).

- [ ] **Step 3: Implement state-machine bookkeeping in `decide()`**

In `packages/server/src/CrawlerAi.ts`, after the phase-transition block and before task selection, add:

```typescript
// If currently in WIND_UP, decrement the wind-up timer and progress the
// state machine.
if (ai.windUpInS > 0) {
  ai.windUpInS -= dt;
  ai.swingFiredThisTick = false;
  // Stagger interrupt (Task 12 wires the accumulator; this check is a
  // no-op until staggerAccumHp is populated).
  if (ai.staggerAccumHp >= ai.profile.staggerThresholdHp) {
    // Skip swing — straight to RECOVERY.
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
  // While in WIND_UP or transitioning out, keep the task as ATTACK_PLAYER
  // and skip task re-selection.
  return convertTaskKindToCrawlerTask(TaskKind.ATTACK_PLAYER, ai, c, players, grid);
}

if (ai.recoveryInS > 0) {
  ai.recoveryInS -= dt;
  if (ai.recoveryInS <= 0) {
    // Recovery complete → force re-priority.
    ai.recoveryInS = 0;
    ai.reevalInS = 0;
  }
  return convertTaskKindToCrawlerTask(TaskKind.IDLE, ai, c, players, grid);
}
```

Add `getInternalAi` debug accessor:

```typescript
getInternalAi(crawlerId: number): Readonly<CrawlerAi> | null {
  return this.states.get(crawlerId) ?? null;
}
```

When task selection picks `ATTACK_PLAYER` (Task 8 logic), the manager must initialize the wind-up:

```typescript
if (newTask === TaskKind.ATTACK_PLAYER && ai.currentTask !== TaskKind.ATTACK_PLAYER) {
  ai.windUpInS = ai.profile.windUpDurS;
  ai.attackTargetPlayerId = near?.id ?? null;
}
```

- [ ] **Step 4: Update `CrawlerState` propagation from manager to executor**

In `packages/server/src/Room.ts`, the bug-step loop reads the manager's task and calls `stepCrawler`. We also need to propagate the manager's wind-up state into the wire-visible `CrawlerState.windUpInS` so clients see the bar tick down. After the `stepCrawler` call:

```typescript
const ai = this.crawlerAi.getInternalAi(c.id);
if (ai) {
  next.windUpInS = ai.windUpInS;
  if (ai.swingFiredThisTick) {
    // (Future: emit a SwingFired snapshot event. C2 just lets the
    // client infer the swing from windUpInS reaching 0.)
  }
}
```

(Field names match the manager's interface.)

- [ ] **Step 5: Run the new tests**

```
npm run -w @gridforce/server test -- --grep "wind-up:" 2>&1 | tail -10
```

Expected: 2 tests pass.

- [ ] **Step 6: Confirm no regression**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 7: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/Room.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "ai: WIND_UP timer + SWING + RECOVERY state machine for ATTACK_PLAYER"
```

---

## Task 11: `applyWeightIntegrity` exclusions

**Files:**
- Modify: `packages/server/src/Room.ts`
- Test: `packages/server/src/test/integrity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/test/integrity.test.ts`:

```typescript
test('WIND_UP bug contributes zero weight to its tile across many ticks', () => {
  const room = makeRoom();
  // Place a bug at melee gap of a stationary pilot.
  setPlayerAt(room, 5, 5);
  const bug: CrawlerState = {
    id: 1, x: 5 * 64 + 50, y: 5 * 64 + 32, facing: 0, hp: 1,
    targetCx: 5, targetCy: 5,
    ai: CrawlerAIState.WIND_UP,
    windUpInS: 5.0, // long enough to outlive the test
  };
  room.crawlers.set(1, bug);

  const initialL1 = room.tiles.l1Hp[indexOf(room.grid.cols, 5, 5)];
  // Tick many physics steps — the bug should not damage the tile.
  for (let i = 0; i < 30; i++) {
    room.applyWeightIntegrity(1 / 30);
  }
  const finalL1 = room.tiles.l1Hp[indexOf(room.grid.cols, 5, 5)];
  assert.equal(finalL1, initialL1);
});
```

You may need to expose `applyWeightIntegrity` as public (or test the effect indirectly via `physicsStep` and a pilot-less room).

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "WIND_UP bug contributes" 2>&1 | tail -10
```

Expected: tile HP drops (current code treats WIND_UP value as if it were ATTACKING).

- [ ] **Step 3: Add exclusion to `applyWeightIntegrity`**

In `packages/server/src/Room.ts`, inside `applyWeightIntegrity`, find the per-bug weight aggregation loop. Add at the top of the loop body:

```typescript
// Only ATTACK_TILE bugs (state = ATTACKING) contribute weight. Bugs in
// WIND_UP, RECOVERY, SEARCHING, IDLE, or APPROACHING are not chewing
// the tile they stand on.
if (c.ai !== CrawlerAIState.ATTACKING) continue;
```

- [ ] **Step 4: Run the new test**

```
npm run -w @gridforce/server test -- --grep "WIND_UP bug" 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 5: Run all tests**

Other integrity tests may have stale assumptions. Inspect:

```
npm test 2>&1 | grep -B 1 "✘\|fail" | head -20
```

Expected: green. The C1.9 behavior was already gated on ATTACKING via stepCrawler's task→state mapping, so this is mostly defensive.

- [ ] **Step 6: Commit**

```
git add packages/server/src/Room.ts packages/server/src/test/integrity.test.ts
git commit -m "integrity: only ATTACKING-state bugs contribute weight (WIND_UP/RECOVERY/etc. excluded)"
```

---

## Task 12: Stagger accumulator on damage

**Files:**
- Modify: `packages/server/src/Room.ts` (`damageCrawlersOnTile` notifies manager)
- Test: `packages/server/src/test/crawler-ai.test.ts` (new test)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test('stagger: damage during wind-up accumulates; threshold cancels swing', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 332, 320);
  const player = newPlayer(0, 320, 320);
  // Enter WIND_UP.
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  const ai0 = mgr.getInternalAi(1)!;
  assert.ok(ai0.windUpInS > 0);

  // Hit the bug for 2 hp (= staggerThresholdHp). Wind-up should cancel.
  mgr.onDamageTaken(1, 2, 0, 0);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  const ai1 = mgr.getInternalAi(1)!;
  // No swing should have fired.
  assert.equal(ai1.swingFiredThisTick, false);
  // Bug should be in RECOVERY.
  assert.ok(ai1.recoveryInS > 0);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "stagger:" 2>&1 | tail -5
```

Expected: bug not yet in RECOVERY (existing wind-up check doesn't see the stagger accumulator unless it crossed threshold within the same tick — confirm via the manager's flow). If failing, proceed.

- [ ] **Step 3: Plumb damage notifications from Room to manager**

In `packages/server/src/Room.ts`, find `damageCrawlersOnTile`. Modify to notify the AI manager (using the shock fire's source if available; for tile-shock linger, source is the tile center):

```typescript
private damageCrawlersOnTile(
  tx: number, ty: number, amount: number,
  sourceX = (tx + 0.5) * this.grid.panelSize,
  sourceY = (ty + 0.5) * this.grid.panelSize,
): void {
  // … existing damage application …
  for (const [cid, c] of this.crawlers) {
    if (c.x >= tileMinX && c.x < tileMaxX && c.y >= tileMinY && c.y < tileMaxY) {
      const newHp = Math.max(0, c.hp - amount);
      // NEW: notify manager of damage taken.
      this.crawlerAi.onDamageTaken(cid, amount, sourceX, sourceY);
      // … rest of the existing block (kill / hp-update) …
    }
  }
}
```

- [ ] **Step 4: Run the new test**

```
npm run -w @gridforce/server test -- --grep "stagger:" 2>&1 | tail -5
```

Expected: pass.

- [ ] **Step 5: Confirm no regression**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 6: Commit**

```
git add packages/server/src/Room.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "ai: stagger accumulator — damage in window breaks wind-up early"
```

---

## Task 13: `SEEK_TILE` task — target selection + walking executor branch

**Files:**
- Modify: `packages/shared/src/enemies/crawler.ts` (stepCrawler executor)
- Modify: `packages/shared/src/types.ts` (extend `CrawlerTask` union with SEEK_TILE shape)
- Modify: `packages/server/src/CrawlerAi.ts` (set `ai.taskTargetCx/Cy` on SEEK_TILE entry)
- Test: extend `packages/server/src/test/crawler-ai.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test('SEEK_TILE: picks the most damaged tile within seekTileRadiusPx and walks toward it', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  // Damage tile (7, 5) significantly; leave others healthy.
  tiles.l1Hp[indexOf(GRID.cols, 7, 5)] = 10;
  const bug = newBug(1, 320, 320); // tile (5, 5)
  // Force SEEK_TILE pick.
  mgr.forceTask(1, TaskKind.SEEK_TILE);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  const ai = mgr.getInternalAi(1)!;
  assert.equal(ai.taskTargetCx, 7);
  assert.equal(ai.taskTargetCy, 5);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "SEEK_TILE:" 2>&1 | tail -5
```

Expected: `forceTask` undefined.

- [ ] **Step 3: Add `forceTask` test hook and SEEK_TILE entry logic**

In `packages/server/src/CrawlerAi.ts`:

```typescript
forceTask(crawlerId: number, task: TaskKindValue): void {
  const ai = this.states.get(crawlerId);
  if (!ai) return;
  ai.currentTask = task;
  ai.taskCommitmentS = 0;
}
```

In the task-switch block (when `newTask` differs from `ai.currentTask`):

```typescript
if (newTask === TaskKind.SEEK_TILE) {
  const best = this.findBestSeekTile(c, ai.profile.seekTileRadiusPx, tiles, grid);
  if (best) {
    ai.taskTargetCx = best.tx;
    ai.taskTargetCy = best.ty;
    ai.taskTargetX = (best.tx + 0.5) * grid.panelSize;
    ai.taskTargetY = (best.ty + 0.5) * grid.panelSize;
  }
}
```

(Manager already has `findBestSeekTile` from Task 7.)

- [ ] **Step 4: Add SEEK_TILE executor branch**

Extend the shared `CrawlerTask` union in `packages/shared/src/enemies/crawler.ts`:

```typescript
export const CrawlerTaskKind = {
  CHASE_PLAYER: 0,
  ATTACK_TILE: 1,
  SEEK_TILE: 2,
} as const;

export type CrawlerTask =
  | { kind: typeof CrawlerTaskKind.CHASE_PLAYER; targetX: number; targetY: number }
  | { kind: typeof CrawlerTaskKind.ATTACK_TILE;  targetCx: number; targetCy: number }
  | { kind: typeof CrawlerTaskKind.SEEK_TILE;    targetCx: number; targetCy: number };
```

In `stepCrawler`, add a branch:

```typescript
if (task.kind === CrawlerTaskKind.SEEK_TILE) {
  // Walk toward the centre of (targetCx, targetCy). On arrival, transition
  // to ATTACKING — the manager will see state=ATTACKING and pick
  // ATTACK_TILE on the next reroll. (Or it switches via the task layer;
  // simpler to expose arrival via the state field.)
  const tx = (task.targetCx + 0.5) * grid.panelSize;
  const ty = (task.targetCy + 0.5) * grid.panelSize;
  const dx = tx - c.x;
  const dy = ty - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist < grid.panelSize * 0.25) {
    return { ...c, ai: CrawlerAIState.ATTACKING, targetCx: task.targetCx, targetCy: task.targetCy };
  }
  const step = CRAWLER_MOVE_SPEED * dt;
  const move = Math.min(step, dist);
  const nx = c.x + (dx / dist) * move;
  const ny = c.y + (dy / dist) * move;
  return {
    ...c,
    ai: CrawlerAIState.APPROACHING,
    x: nx, y: ny,
    facing: Math.atan2(dy, dx),
    targetCx: task.targetCx, targetCy: task.targetCy,
  };
}
```

Update the manager's `taskKindToCrawlerTask`:

```typescript
case TaskKind.SEEK_TILE:
  return { kind: CrawlerTaskKind.SEEK_TILE, targetCx: ai.taskTargetCx, targetCy: ai.taskTargetCy };
```

- [ ] **Step 5: Run the new test**

```
npm run -w @gridforce/server test -- --grep "SEEK_TILE:" 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 6: Confirm no regression**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 7: Commit**

```
git add packages/shared/src/enemies/crawler.ts packages/server/src/CrawlerAi.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "tasks: SEEK_TILE — pick most-damaged tile in radius, walk toward it"
```

---

## Task 14: `SEARCH` task — wandering with widened detection

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`
- Modify: `packages/shared/src/enemies/crawler.ts`
- Test: extend `packages/server/src/test/crawler-ai.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
test('SEARCH: bug walks toward a random wander target', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.forceTask(1, TaskKind.SEARCH);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  const ai = mgr.getInternalAi(1)!;
  // A wander target should be picked.
  assert.ok(ai.taskTargetX !== 0 || ai.taskTargetY !== 0);
});

test('SEARCH: phase check sees pilots from detectionRadius × searchRadiusMult', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.forceTask(1, TaskKind.SEARCH);
  // Pilot at 220 px — just outside base 160 detection radius, well
  // within 160 × 1.6 = 256 widened radius.
  const player = newPlayer(0, 540, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "SEARCH:" 2>&1 | tail -10
```

Expected: fail (no wander target picker yet).

- [ ] **Step 3: Implement SEARCH entry — pick a wander target**

In the manager's task-switch block:

```typescript
if (newTask === TaskKind.SEARCH) {
  // Pick a random point within seekTileRadiusPx of the bug.
  const r = ai.profile.seekTileRadiusPx;
  const angle = Math.random() * Math.PI * 2;
  const dist = r * (0.5 + Math.random() * 0.5);
  ai.taskTargetX = c.x + Math.cos(angle) * dist;
  ai.taskTargetY = c.y + Math.sin(angle) * dist;
}
```

- [ ] **Step 4: Map SEARCH to a CrawlerTask + add executor branch**

Add `SEARCH: 3` to `CrawlerTaskKind`. Extend the union with a wander variant:

```typescript
| { kind: typeof CrawlerTaskKind.SEARCH; targetX: number; targetY: number };
```

In `stepCrawler`, the SEARCH branch reuses the CHASE walking path but emits `CrawlerAIState.SEARCHING`:

```typescript
if (task.kind === CrawlerTaskKind.SEARCH) {
  const dx = task.targetX - c.x;
  const dy = task.targetY - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 4) {
    // Arrived — manager will reroll on next decide.
    return { ...c, ai: CrawlerAIState.SEARCHING };
  }
  const step = CRAWLER_MOVE_SPEED * dt * 0.7;
  const move = Math.min(step, dist);
  return {
    ...c,
    ai: CrawlerAIState.SEARCHING,
    x: c.x + (dx / dist) * move,
    y: c.y + (dy / dist) * move,
    facing: Math.atan2(dy, dx),
  };
}
```

Update `taskKindToCrawlerTask` for SEARCH:

```typescript
case TaskKind.SEARCH:
  return { kind: CrawlerTaskKind.SEARCH, targetX: ai.taskTargetX, targetY: ai.taskTargetY };
```

The widened-detection part already lives in the phase-transition block (Task 6) via the `if (ai.currentTask === TaskKind.SEARCH) effectiveR *= …` line.

- [ ] **Step 5: Run new tests**

```
npm run -w @gridforce/server test -- --grep "SEARCH:" 2>&1 | tail -10
```

Expected: 2 tests pass.

- [ ] **Step 6: Run all tests**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 7: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/shared/src/enemies/crawler.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "tasks: SEARCH — wander with widened detection radius"
```

---

## Task 15: `INVESTIGATE` task — walk to alert target

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`
- Modify: `packages/shared/src/enemies/crawler.ts`
- Test: extend `packages/server/src/test/crawler-ai.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
test('INVESTIGATE: bug with seeded target walks toward it; consumes on arrival', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  // Bug at (320, 320). Seed an investigate target at (640, 320).
  const bug = newBug(1, 320, 320);
  mgr.onDamageTaken(1, 1, 640, 320); // seeds investigate
  mgr.forceTask(1, TaskKind.INVESTIGATE);
  // First decide — bug should set task target.
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  const ai = mgr.getInternalAi(1)!;
  assert.ok(Math.abs(ai.taskTargetX - 640) < 1);
  assert.ok(Math.abs(ai.taskTargetY - 320) < 1);
});

test('INVESTIGATE: target consumed after stale window', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.onDamageTaken(1, 1, 640, 320);
  // Tick past the stale window (10 s).
  for (let t = 0; t < 11; t += 0.5) {
    mgr.decide(bug, 0.5, [], [bug], tiles, GRID);
  }
  assert.equal(mgr.getInvestigateTarget(1), null);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "INVESTIGATE:" 2>&1 | tail -10
```

- [ ] **Step 3: Implement INVESTIGATE entry**

In the task-switch block:

```typescript
if (newTask === TaskKind.INVESTIGATE && ai.hasInvestigateTarget) {
  ai.taskTargetX = ai.investigateTargetX;
  ai.taskTargetY = ai.investigateTargetY;
}
```

The executor side uses the same CHASE-style walking as SEEK_PLAYER; emit `CrawlerAIState.APPROACHING`. No new state needed (shared visual with chase). Manager consumes the target on arrival:

```typescript
// In decide(), before returning the CrawlerTask:
if (ai.currentTask === TaskKind.INVESTIGATE) {
  const dx = ai.investigateTargetX - c.x;
  const dy = ai.investigateTargetY - c.y;
  if (Math.hypot(dx, dy) < 16) {
    ai.hasInvestigateTarget = false;
    ai.reevalInS = 0; // pick something else next tick
  }
}
```

- [ ] **Step 4: Run new tests**

```
npm run -w @gridforce/server test -- --grep "INVESTIGATE:" 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 5: Run all tests**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 6: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "tasks: INVESTIGATE — walk to alert target, consume on arrival or stale"
```

---

## Task 16: Soft commitment-weighted aggro

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`
- Test: extend `packages/server/src/test/crawler-ai.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
test('soft aggro: fresh ATTACK_TILE bug peels off when player closes within base radius', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  // Damage the tile under the bug so ATTACK_TILE is eligible.
  tiles.l1Hp[indexOf(GRID.cols, 5, 5)] = 50;
  const bug = newBug(1, 320, 320);
  mgr.forceTask(1, TaskKind.ATTACK_TILE);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);

  // Player 100 px away — within base 160 px detection.
  const player = newPlayer(0, 420, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  // Phase should be ENGAGED.
  assert.equal(mgr.getPhase(1), 'ENGAGED');
});

test('soft aggro: 6s-committed ATTACK_TILE bug does NOT peel at 100 px', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  tiles.l1Hp[indexOf(GRID.cols, 5, 5)] = 50;
  const bug = newBug(1, 320, 320);
  mgr.forceTask(1, TaskKind.ATTACK_TILE);
  // Fast-forward 6+ s of commitment with no player.
  for (let t = 0; t < 7; t += 0.5) {
    mgr.decide(bug, 0.5, [], [bug], tiles, GRID);
  }
  // Now bring a player to 100 px. Effective R should be 40 (25% of base);
  // 100 px > 40, so phase stays CALM.
  const player = newPlayer(0, 420, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'CALM');
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "soft aggro:" 2>&1 | tail -10
```

Expected: the second test fails (current effective R is full).

- [ ] **Step 3: Apply commitment-weighted shrink to ATTACK_TILE**

In `packages/server/src/CrawlerAi.ts`, update the effective-radius computation in the phase-transition block:

```typescript
let effectiveR = ai.profile.detectionRadiusPx;
if (ai.currentTask === TaskKind.SEARCH) effectiveR *= ai.profile.searchRadiusMult;
if (ai.alertBonusInS > 0) effectiveR *= ai.profile.alertBonusMult;
if (ai.currentTask === TaskKind.ATTACK_TILE) {
  const t = Math.min(1, ai.taskCommitmentS / ATTACK_COMMITMENT_DECAY_S);
  effectiveR *= 1 - t * (1 - ATTACK_COMMITMENT_FLOOR);
}
const effectiveR2 = effectiveR * effectiveR;
```

(`ATTACK_COMMITMENT_DECAY_S` and `ATTACK_COMMITMENT_FLOOR` were added in Task 4.)

- [ ] **Step 4: Run new tests**

```
npm run -w @gridforce/server test -- --grep "soft aggro:" 2>&1 | tail -10
```

Expected: both pass.

- [ ] **Step 5: Run all tests**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 6: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "ai: commitment-weighted soft aggro shrinks detection while ATTACK_TILE committed"
```

---

## Task 17: Swarm AI emission + reception scaffold

**Files:**
- Modify: `packages/server/src/CrawlerAi.ts`
- Test: extend `packages/server/src/test/crawler-ai.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
test('alert: bug entering SEEK_PLAYER broadcasts CALL_ALERT to peers in radius', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  mgr.registerCrawler(2, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);

  // Bug A near the player. Bug B in CALM phase, 80 px away (within 128 px
  // propagation radius), no player in its own detection range yet.
  const bugA = newBug(1, 320, 320);
  const bugB = newBug(2, 400, 320);
  const player = newPlayer(0, 420, 320); // close to A, far enough that
                                          // B doesn't see it directly
                                          // (160 px detection; player
                                          // is 80 px from B → in range...
                                          // we adjust):
  // Move player out of B's direct detection: pilot at (480, 320) — 160 px
  // from B (right at edge) and 160 px from A (will trigger A).
  const playerFar = newPlayer(0, 480, 320);

  // First, get bug A into ENGAGED and SEEK_PLAYER.
  mgr.forceTask(1, TaskKind.SEEK_PLAYER);
  mgr.decide(bugA, 0.016, [playerFar], [bugA, bugB], tiles, GRID);

  // Bug B should now have an investigateTarget seeded by the alert.
  const target = mgr.getInvestigateTarget(2);
  assert.ok(target);
  assert.ok(Math.abs(target!.x - bugA.x) < 1);
  assert.ok(Math.abs(target!.y - bugA.y) < 1);

  // Bug B's alertBonusInS should be > 0.
  assert.ok(mgr.getInternalAi(2)!.alertBonusInS > 0);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run -w @gridforce/server test -- --grep "alert:" 2>&1 | tail -5
```

Expected: fail.

- [ ] **Step 3: Implement emission + reception**

In `packages/server/src/CrawlerAi.ts`, in the task-switch block, when the new task is `SEEK_PLAYER` AND `ai.currentTask` was not `SEEK_PLAYER`:

```typescript
if (newTask === TaskKind.SEEK_PLAYER && ai.currentTask !== TaskKind.SEEK_PLAYER) {
  this.broadcastCallAlert(c.id, c.x, c.y, ai.profile.alertPropagationRadiusPx);
}
```

Implement the broadcast:

```typescript
private broadcastCallAlert(alerterId: number, x: number, y: number, radiusPx: number): void {
  const r2 = radiusPx * radiusPx;
  for (const [peerId, peerAi] of this.states) {
    if (peerId === alerterId) continue;
    if (!peerAi.lastBugPos) continue;
    const dx = peerAi.lastBugPos.x - x;
    const dy = peerAi.lastBugPos.y - y;
    if (dx * dx + dy * dy > r2) continue;
    peerAi.hasInvestigateTarget = true;
    peerAi.investigateTargetX = x;
    peerAi.investigateTargetY = y;
    peerAi.investigateUntilS = peerAi.profile.investigateStaleS;
    peerAi.alertBonusInS = peerAi.profile.alertBonusDurS;
    if (peerAi.phase === 'CALM') peerAi.phase = 'ENGAGED';
  }
}
```

- [ ] **Step 4: Run the new test**

```
npm run -w @gridforce/server test -- --grep "alert:" 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 5: Run all tests**

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 6: Commit**

```
git add packages/server/src/CrawlerAi.ts packages/server/src/test/crawler-ai.test.ts
git commit -m "ai: swarm scaffold — SEEK_PLAYER entry broadcasts CALL_ALERT (mild mite propagation)"
```

---

## Task 18: Final verification + cleanup + push

**Files:** none new

- [ ] **Step 1: Strip the `legacyDecide` fallback if it's no longer reached**

In `packages/server/src/CrawlerAi.ts`, confirm the new hierarchical task selection covers all paths. Remove the `legacyDecide` method and any references. Re-run tests:

```
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

- [ ] **Step 2: Run typecheck + full test pass**

```
npm run typecheck 2>&1 | tail -5
npm test 2>&1 | grep -E "(tests|pass|fail)" | tail -10
```

Expected: all green.

- [ ] **Step 3: Build the client bundle**

```
npm run build 2>&1 | tail -10
```

Expected: clean Vite build.

- [ ] **Step 4: Manual playtest**

```
npm run dev
```

Open two browser clients. Verify:

1. **Catch-the-pilot:** stand still, let a mite walk onto you. Bug stops adjacent (not on top), enters WIND_UP (charge bar visible). Panel HP under feet does NOT decrement. After ~0.6 s the swing fires; bug enters RECOVERY pose; then resumes priority.
2. **Flood pressure:** spawn ~15 mites, walk a pilot through a row of attacking mites. Bugs that have been chewing ≥5 s do not peel; pilot must shock to peel them.
3. **Mid-map siege:** observe that ~10–20 % of mites in CALM phase pick SEEK_TILE or ATTACK_TILE rather than ALL chasing or ALL sieging.
4. **Alert:** kill a single bug from across the map (shock); nearby bugs should aggro and head toward the source.

- [ ] **Step 5: Commit final cleanup**

```
git add packages/server/src/CrawlerAi.ts
git commit -m "ai: drop legacyDecide fallback; C2 task vocabulary complete"
git push origin main
```

The webhook will auto-deploy.

---

## Self-review (post-write checklist)

- [x] Spec coverage: 7 tasks for the 7 v1 task verbs; phase model in Task 6; ATTACK_PLAYER state machine in Tasks 9–10; stagger in Task 12; soft aggro in Task 16; swarm scaffold in Task 17; wire format in Task 1.
- [x] Placeholder scan: code examples concrete. The `legacyDecide` block in Task 5 explicitly says "copy the C1.9 body" — engineer must do this verbatim. Marked clearly.
- [x] Type consistency: `TaskKindValue` consistent across tasks; `CrawlerAi` fields added cumulatively; `EnemyProfile.crowdRadiusPx` added in Task 7 (note: also update `MITE_PROFILE` in Task 3 if not already there — add `crowdRadiusPx: 128`).
- [x] Out-of-scope items deferred: SwingFired event emission is a TODO in Task 10 step 4 (mentioned but no impl); C3 player-damage resolution is explicit non-goal.
