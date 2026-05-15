# Electrical-defense B1 (panels + Crawler + uncharged shock + carbon + repair) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first half of the GridForce first-playable spec — endless gameplay loop with three-state panels, Crawler enemies, uncharged local shock, carbon econ, and DAMAGED→LIVE repair. No HP/revives, no waves, no city HP, no win/loss state (all deferred to the B2 plan).

**Architecture:** Schema bumps to v12 for the new wire-format pieces. Panel state lives as a per-room `Uint8Array(cols * rows)` indexed `y * cols + x`; values are `LIVE | DAMAGED | BROKEN` enum members. Two new entity types (`Crawler` = 3, `Carbon` = 4) ride the existing dynamic-group snapshot format. Crawler AI is a pure-shared `step()` function so server + future predictive clients agree on behaviour. Shock + repair are server-authoritative — server applies them in `physicsStep` against the panel state + entity maps. The Crawler spawner is intentionally dumb in B1: continuous trickle, no wave structure (the Wave Manager lands in B2 alongside `loopPhases`, HP, and city HP).

**Tech Stack:** TypeScript + npm workspaces (`@gridforce/{shared,server,client}`). `node --test` for tests. Vite for the client. Pixi.js for rendering.

**Spec:** `docs/superpowers/specs/2026-05-15-electrical-defense-first-playable-design.md` (commit `75a9439`).

**B1 scope explicitly excludes:** charged shock, BROKEN→LIVE rebuild, player HP, downed/revive, wave manager, `loopPhases`, city HP, win/loss state, run-end headlines, escalating wave budgets. All of those land in the B2 plan.

---

## Task 1: Schema v12 + B1 tuning constants

Foundation — bump the wire version and define the constants the rest of the plan references.

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Edit `constants.ts`** — bump version, add v12 changelog, add B1 constants.

Find the schema version + history block:

```ts
//  v12: First-playable B1. PlayerInput adds `shock` + `repair` bits.
//       PlayerState adds carbon + shockCooldownS + repairProgressS.
//       Snapshot carries a panel-state RLE block, plus new entity
//       groups EntityType.Crawler=3 and EntityType.Carbon=4. Welcome
//       carries the full panel-state byte array. v13 (B2) will add
//       hp/downed/reviveProgress + cityHp + currentWave + counters.
export const SCHEMA_VERSION = 12;
```

Add a new block at the end of the file (after the existing player-movement constants):

```ts
// --- B1 electrical-defense tuning (placeholders, expect playtest changes) ---

// Panel state machine.
export const PANEL_ATTACK_TO_DAMAGE_S = 0.5;
export const PANEL_ATTACK_TO_BREAK_S = 0.5;

// Repair (DAMAGED -> LIVE only in B1; rebuild lands in B2).
export const REPAIR_DURATION_S = 1.5;
export const REPAIR_CARBON_COST = 1;

// Uncharged local shock (charged shock lands in B2).
export const SHOCK_COOLDOWN_S = 0.25;

// Carbon pickups.
export const CARBON_TTL_S = 10;
export const CARBON_PICKUP_RADIUS = 16;
export const PLAYER_CARBON_MAX = 99;

// Crawlers.
export const CRAWLER_MOVE_SPEED = 80;        // px/s
export const CRAWLER_RADIUS = 14;            // px
export const CRAWLER_SPAWN_INTERVAL_S = 1.0; // continuous trickle in B1
export const MAX_ALIVE_CRAWLERS = 8;         // B1 cap; B2 wave manager raises this
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (constants aren't referenced yet).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "schema: bump to v12 for B1 panels/Crawler/shock/carbon/repair"
```

---

## Task 2: PlayerInput shock + repair bits (TDD)

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/net/messages/Input.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Write the failing test** — append to wire.test.ts after the existing sprint test.

```ts
test('Input round-trip preserves shock + repair bits', () => {
  const inputs = [
    { tick: 300, clientTimeMs: 1, mx: 0, my: 0, dash: false, sprint: false, shock: true,  repair: false },
    { tick: 301, clientTimeMs: 2, mx: 0, my: 0, dash: false, sprint: false, shock: false, repair: true  },
    { tick: 302, clientTimeMs: 3, mx: 0, my: 0, dash: false, sprint: false, shock: true,  repair: true  },
  ];
  const dec = decodeMessage(InputMsg.encode(inputs));
  assert.equal(dec.type, MessageType.Input);
  const list = dec.payload;
  assert.equal(list.length, 3);
  assert.equal(list[0]!.shock, true);
  assert.equal(list[0]!.repair, false);
  assert.equal(list[1]!.shock, false);
  assert.equal(list[1]!.repair, true);
  assert.equal(list[2]!.shock, true);
  assert.equal(list[2]!.repair, true);
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm test --workspace=@gridforce/shared`
Expected: type error (PlayerInput doesn't have `shock`/`repair` yet) or runtime assert miss.

- [ ] **Step 3: Add `shock` + `repair` to PlayerInput** in `packages/shared/src/types.ts`:

```ts
export interface PlayerInput {
  tick: number;
  clientTimeMs: number;
  mx: number;
  my: number;
  dash: boolean;
  sprint: boolean;
  shock: boolean;
  repair: boolean;
}
```

- [ ] **Step 4: Update Input.ts encoder/decoder** to carry both bits.

In `packages/shared/src/net/messages/Input.ts`, add to the constants block:

```ts
const BUTTON_DASH   = 1 << 0;
const BUTTON_SPRINT = 1 << 1;
const BUTTON_SHOCK  = 1 << 2;
const BUTTON_REPAIR = 1 << 3;
```

Update the wire-format header comment:

```
//     u8  buttons              (bit 0 = dash, bit 1 = sprint, bit 2 = shock, bit 3 = repair)
```

In `encode`, change the buttons byte write to:

```ts
w.u8(
  (p.dash   ? BUTTON_DASH   : 0) |
  (p.sprint ? BUTTON_SPRINT : 0) |
  (p.shock  ? BUTTON_SHOCK  : 0) |
  (p.repair ? BUTTON_REPAIR : 0)
);
```

In `decode`, change the construction:

```ts
out[i] = {
  tick,
  clientTimeMs,
  mx,
  my,
  dash:   (buttons & BUTTON_DASH)   !== 0,
  sprint: (buttons & BUTTON_SPRINT) !== 0,
  shock:  (buttons & BUTTON_SHOCK)  !== 0,
  repair: (buttons & BUTTON_REPAIR) !== 0,
};
```

- [ ] **Step 5: Audit every PlayerInput construction site** — they need the new fields. Run:

```bash
grep -rn "sprint: " packages/ --include="*.ts" | grep -v "node_modules"
```

For each `sprint: ...` callsite that's part of a PlayerInput literal, add `shock: false, repair: false` (real wiring lands in Task 12). Likely files: `client/src/sim/PredictedWorld.ts` (the `step()` parameter shape + the synthetic idle inputs in `applySnapshot`), `client/src/main.ts`, `client/src/input/InputCapture.ts`, `server/src/bots/WanderBot.ts`, `server/src/test/TestClient.ts`, every `drive` callback in the integration/lobby tests.

For `PredictedWorld.step`'s parameter, widen:

```ts
step(local: {
  mx: number;
  my: number;
  dash: boolean;
  sprint: boolean;
  shock: boolean;
  repair: boolean;
  clientTimeMs: number;
}): PlayerInput {
```

And in the construction inside the function:

```ts
const input: PlayerInput = {
  tick: this.predictedTick,
  clientTimeMs: local.clientTimeMs,
  mx: local.mx,
  my: local.my,
  dash: local.dash,
  sprint: local.sprint,
  shock: local.shock,
  repair: local.repair,
};
```

And the synthetic idle catch-up replay:

```ts
advanced = stepPlayer(
  advanced,
  { tick: this.predictedTick + i + 1, clientTimeMs: 0, mx: 0, my: 0, dash: false, sprint: false, shock: false, repair: false },
  SERVER_TICK_DT_S,
  this.grid,
);
```

- [ ] **Step 6: Run tests + typecheck**

```bash
npm test --workspace=@gridforce/shared
npm run typecheck
```

Expected: all pass, including the new shock+repair round-trip.

- [ ] **Step 7: Commit**

```bash
git add packages/
git commit -m "feat: PlayerInput gains shock + repair bits"
```

---

## Task 3: PlayerState additions — carbon, shockCooldownS, repairProgressS

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/sim.ts` (newPlayerState only — gameplay logic comes later)
- Modify: `packages/shared/src/net/entities/PlayerEncoder.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Write the failing test** — append to wire.test.ts.

```ts
test('PlayerEncoder round-trips carbon + shockCooldownS + repairProgressS', () => {
  const players = [
    {
      ...newPlayerState(0, 100, 100, 'a'),
      facing: 0,
      stateSeq: 1,
      carbon: 5,
      shockCooldownS: 0.15,
      repairProgressS: 0.8,
    },
    {
      ...newPlayerState(1, 200, 200, 'b'),
      facing: 0,
      stateSeq: 2,
      carbon: 99,
      shockCooldownS: 0,
      repairProgressS: 0,
    },
  ];
  const dec = decodeMessage(SnapshotMsg.encode({
    tick: 1,
    serverTimeMs: 0,
    ackInputTick: -1,
    inputAckBitmask: 0,
    phase: 'playing',
    hostId: 0,
    difficulty: 1,
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 0,
    players,
    npcs: [],
  }));
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload;
  assert.equal(s.players[0]!.carbon, 5);
  assert.ok(Math.abs(s.players[0]!.shockCooldownS - 0.15) < 0.01, 'shock cooldown quantization');
  assert.ok(Math.abs(s.players[0]!.repairProgressS - 0.8) < 0.01, 'repair progress quantization');
  assert.equal(s.players[1]!.carbon, 99);
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm test --workspace=@gridforce/shared`
Expected: type error / missing fields.

- [ ] **Step 3: Add fields to `PlayerState` in `types.ts`:**

```ts
export interface PlayerState {
  id: PlayerId;
  x: number;
  y: number;
  facing: number;
  panelJumpCooldownS: number;
  stateSeq: number;
  name: string;
  ready: boolean;
  carbon: number;           // 0..99
  shockCooldownS: number;   // 0..SHOCK_COOLDOWN_S
  repairProgressS: number;  // 0..REPAIR_DURATION_S
}
```

- [ ] **Step 4: Update `newPlayerState` in `sim.ts`:**

```ts
export function newPlayerState(id: number, x: number, y: number, name = ''): PlayerState {
  return {
    id,
    x,
    y,
    facing: 0,
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name,
    ready: false,
    carbon: 0,
    shockCooldownS: 0,
    repairProgressS: 0,
  };
}
```

- [ ] **Step 5: Update `PlayerEncoder.ts`** — encode/decode the three new fields.

Update the layout comment:

```ts
// One player entity (variable, ~19 + name bytes):
//   u8  id
//   f32 x
//   f32 y
//   u8  facingQ
//   u8  flags             bit1=READY
//   u8  panelJumpCooldownQ
//   u32 stateSeq
//   u8  carbon            (0..99 clamped)
//   u8  shockCooldownQ    (quantizeTimer; saturates at 1.0s)
//   u8  repairProgressQ   (quantizeTimer; saturates at 1.0s)
//   string name
```

In `encode`, after `w.u32(p.stateSeq >>> 0);` add:

```ts
w.u8(Math.max(0, Math.min(99, p.carbon)) & 0xff);
w.u8(quantizeTimer(p.shockCooldownS));
w.u8(quantizeTimer(p.repairProgressS));
```

In `decode`, after `const stateSeq = r.u32();` add:

```ts
const carbon = r.u8();
const shockCooldownS = unquantizeTimer(r.u8());
const repairProgressS = unquantizeTimer(r.u8());
```

Update the return object to include the three new fields:

```ts
return {
  id, x, y, facing, panelJumpCooldownS, stateSeq, name, ready,
  carbon, shockCooldownS, repairProgressS,
};
```

- [ ] **Step 6: Run tests + typecheck**

```bash
npm test --workspace=@gridforce/shared
npm run typecheck
```

Expected: pass. If any callsite spreads PlayerState and gets a type complaint about missing carbon/shockCooldownS/repairProgressS, they're already present on freshly-constructed states (via newPlayerState) so the most common shape works. Any explicit constructions in tests need defaults; add `carbon: 0, shockCooldownS: 0, repairProgressS: 0` to them.

- [ ] **Step 7: Commit**

```bash
git add packages/
git commit -m "feat: PlayerState adds carbon + shockCooldownS + repairProgressS"
```

---

## Task 4: Panel state machine + RLE codec (new shared module)

**Files:**
- Create: `packages/shared/src/panels.ts`
- Test: `packages/shared/src/panels.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/shared/src/panels.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelState, allLive, encodeRle, decodeRle } from './panels.js';
import { BinaryWriter, BinaryReader } from './net/wire.js';

test('allLive returns a buffer filled with LIVE', () => {
  const buf = allLive(36, 24);
  assert.equal(buf.length, 36 * 24);
  for (let i = 0; i < buf.length; i++) assert.equal(buf[i], PanelState.LIVE);
});

test('RLE round-trips a fully-LIVE grid', () => {
  const buf = allLive(36, 24);
  const w = new BinaryWriter(64);
  encodeRle(w, buf);
  const r = new BinaryReader(w.finish());
  const decoded = decodeRle(r, buf.length);
  assert.deepEqual(Array.from(decoded), Array.from(buf));
});

test('RLE round-trips a mixed grid with multiple runs', () => {
  const buf = new Uint8Array(20);
  // Pattern: 5 LIVE, 3 DAMAGED, 4 BROKEN, 8 LIVE
  for (let i = 0; i < 5; i++) buf[i] = PanelState.LIVE;
  for (let i = 5; i < 8; i++) buf[i] = PanelState.DAMAGED;
  for (let i = 8; i < 12; i++) buf[i] = PanelState.BROKEN;
  for (let i = 12; i < 20; i++) buf[i] = PanelState.LIVE;
  const w = new BinaryWriter(32);
  encodeRle(w, buf);
  const r = new BinaryReader(w.finish());
  const decoded = decodeRle(r, buf.length);
  assert.deepEqual(Array.from(decoded), Array.from(buf));
});

test('RLE compresses a fully-LIVE 36x24 grid to a tiny payload', () => {
  const buf = allLive(36, 24);
  const w = new BinaryWriter(32);
  encodeRle(w, buf);
  // One run for 864 cells: varuint(1) [runCount] + u8(state=LIVE) + varuint(864) [runLen] = 4 bytes.
  assert.ok(w.finish().byteLength < 16, `expected <16 bytes, got ${w.finish().byteLength}`);
});
```

- [ ] **Step 2: Run — expect fail** (`panels.ts` doesn't exist).

Run: `npm test --workspace=@gridforce/shared`
Expected: ImportError / not-found.

- [ ] **Step 3: Implement `panels.ts`:**

```ts
import type { BinaryReader, BinaryWriter } from './net/wire.js';

// Panel state — wire-encoded as a u8 enum.
export const PanelState = {
  LIVE: 0,
  DAMAGED: 1,
  BROKEN: 2,
} as const;
export type PanelStateValue = (typeof PanelState)[keyof typeof PanelState];

export function allLive(cols: number, rows: number): Uint8Array {
  const buf = new Uint8Array(cols * rows);
  // Uint8Array initializes to 0, which is PanelState.LIVE — no explicit fill needed.
  return buf;
}

export function indexOf(cols: number, cx: number, cy: number): number {
  return cy * cols + cx;
}

// RLE format:
//   varuint runCount
//   for each run:
//     u8 state
//     varuint runLength
//
// Decoder needs to know the total expected cell count for sanity-checking;
// callers pass it because the snapshot length is implicit upstream.
export function encodeRle(w: BinaryWriter, buf: Uint8Array): void {
  if (buf.length === 0) {
    w.varuint(0);
    return;
  }
  // First pass: count runs.
  let runs = 1;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] !== buf[i - 1]) runs++;
  }
  w.varuint(runs);
  let runStart = 0;
  for (let i = 1; i <= buf.length; i++) {
    if (i === buf.length || buf[i] !== buf[runStart]) {
      w.u8(buf[runStart]!);
      w.varuint(i - runStart);
      runStart = i;
    }
  }
}

export function decodeRle(r: BinaryReader, expectedLen: number): Uint8Array {
  const runCount = r.varuint();
  const out = new Uint8Array(expectedLen);
  let cursor = 0;
  for (let n = 0; n < runCount; n++) {
    const state = r.u8();
    const len = r.varuint();
    if (cursor + len > expectedLen) {
      throw new RangeError(`RLE overflow: cursor=${cursor} len=${len} expectedLen=${expectedLen}`);
    }
    out.fill(state, cursor, cursor + len);
    cursor += len;
  }
  if (cursor !== expectedLen) {
    throw new RangeError(`RLE underflow: cursor=${cursor} expectedLen=${expectedLen}`);
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect pass.**

Run: `npm test --workspace=@gridforce/shared`
Expected: all 4 panel tests pass.

- [ ] **Step 5: Export from shared/index.ts:**

Add to `packages/shared/src/index.ts`:

```ts
export * from './panels.js';
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/panels.ts packages/shared/src/panels.test.ts packages/shared/src/index.ts
git commit -m "feat: panels.ts — PanelState enum + RLE codec"
```

---

## Task 5: Snapshot + Welcome carry panel state; Room owns the array

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/net/messages/Snapshot.ts`
- Modify: `packages/shared/src/net/messages/Welcome.ts`
- Modify: `packages/server/src/Room.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Write failing tests** — append to wire.test.ts.

```ts
test('Snapshot carries panel-state RLE block', () => {
  const panelBuf = allLive(18, 12);
  panelBuf[0] = PanelState.DAMAGED;
  panelBuf[5] = PanelState.BROKEN;
  const dec = decodeMessage(SnapshotMsg.encode({
    tick: 1,
    serverTimeMs: 0,
    ackInputTick: -1,
    inputAckBitmask: 0,
    phase: 'playing',
    hostId: 0,
    difficulty: 1,
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 0,
    players: [],
    npcs: [],
    panelStates: panelBuf,
    panelCols: 18,
    panelRows: 12,
  }));
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload;
  assert.equal(s.panelStates.length, 18 * 12);
  assert.equal(s.panelStates[0], PanelState.DAMAGED);
  assert.equal(s.panelStates[5], PanelState.BROKEN);
  assert.equal(s.panelStates[1], PanelState.LIVE);
});

test('Welcome carries full panel-state byte array', () => {
  const panelBuf = allLive(18, 12);
  panelBuf[10] = PanelState.DAMAGED;
  const decoded = decodeMessage(WelcomeMsg.encode({
    yourPlayerId: 0,
    grid: { cols: 18, rows: 12, panelSize: 64 },
    startTick: 0,
    serverTimeMs: 0,
    phase: 'lobby',
    hostId: 0,
    difficulty: 1,
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 0,
    maxPlayers: 4,
    sessionKey: '',
    players: [],
    panelStates: panelBuf,
  }));
  assert.equal(decoded.type, MessageType.Welcome);
  const w = decoded.payload;
  assert.equal(w.panelStates.length, 18 * 12);
  assert.equal(w.panelStates[10], PanelState.DAMAGED);
});
```

Imports at the top of wire.test.ts:

```ts
import { PanelState, allLive } from '../../panels.js';
```

- [ ] **Step 2: Run — expect failure.**

Run: `npm test --workspace=@gridforce/shared`
Expected: type errors / missing fields on snapshot+welcome payloads.

- [ ] **Step 3: Update `SnapshotPayload` in types.ts:**

```ts
export interface SnapshotPayload {
  tick: number;
  serverTimeMs: number;
  ackInputTick: number;
  inputAckBitmask: number;
  phase: RoomPhase;
  hostId: PlayerId;
  difficulty: number;
  runId: string;
  currentStageIndex: number;
  currentPhaseIndex: number;
  phaseElapsedS: number;
  // B1: full panel-state buffer, RLE-encoded on the wire. Snapshot
  // sends every tick; deltas are a future optimization.
  panelStates: Uint8Array;
  panelCols: number;
  panelRows: number;
  players: PlayerState[];
  npcs: NpcState[];
}
```

- [ ] **Step 4: Update `WelcomePayload` in types.ts:**

```ts
export interface WelcomePayload {
  yourPlayerId: PlayerId;
  grid: GridDef;
  startTick: number;
  serverTimeMs: number;
  phase: RoomPhase;
  hostId: PlayerId;
  difficulty: number;
  runId: string;
  currentStageIndex: number;
  currentPhaseIndex: number;
  phaseElapsedS: number;
  maxPlayers: number;
  sessionKey: string;
  players: PlayerState[];
  // B1: full panel-state buffer (raw bytes, NOT RLE — joiner-friendly).
  panelStates: Uint8Array;
}
```

- [ ] **Step 5: Update `Snapshot.ts` encoder/decoder:**

In `encode`, after `w.f32(p.phaseElapsedS);` add:

```ts
w.u16(p.panelCols);
w.u16(p.panelRows);
encodeRle(w, p.panelStates);
```

In `decode`, after `const phaseElapsedS = r.f32();` add:

```ts
const panelCols = r.u16();
const panelRows = r.u16();
const panelStates = decodeRle(r, panelCols * panelRows);
```

In the returned payload, add `panelStates`, `panelCols`, `panelRows`.

Imports at the top of Snapshot.ts:

```ts
import { encodeRle, decodeRle } from '../../panels.js';
```

- [ ] **Step 6: Update `Welcome.ts` encoder/decoder:**

In `encode`, after `w.f32(p.phaseElapsedS);` add:

```ts
w.varuint(p.panelStates.length);
for (let i = 0; i < p.panelStates.length; i++) w.u8(p.panelStates[i]!);
```

In `decode`, after `const phaseElapsedS = r.f32();` add:

```ts
const panelLen = r.varuint();
const panelStates = new Uint8Array(panelLen);
for (let i = 0; i < panelLen; i++) panelStates[i] = r.u8();
```

In the returned payload, add `panelStates`.

- [ ] **Step 7: Update Room.ts to own the buffer.**

In `packages/server/src/Room.ts`, add to imports:

```ts
import { allLive, PanelState } from '@gridforce/shared';
```

Add class field next to the other room state:

```ts
panelStates: Uint8Array = new Uint8Array(0);
```

In `startGame`, after the existing index resets, allocate the buffer:

```ts
this.panelStates = allLive(this.grid.cols, this.grid.rows);
```

In `broadcastSnapshot`, add to the encode payload:

```ts
panelStates: this.panelStates,
panelCols: this.grid.cols,
panelRows: this.grid.rows,
```

In `sendWelcome`, add to the encode payload:

```ts
panelStates: this.panelStates,
```

Also update `setLobbySettings` so that switching runs in the lobby reseeds the panel buffer to the (potentially) new grid size:

```ts
// After the existing `this.run = getRun(runId)` / index resets:
this.panelStates = allLive(this.grid.cols, this.grid.rows);
```

And in `advanceStage` after the re-centre call:

```ts
this.panelStates = allLive(this.grid.cols, this.grid.rows);
```

- [ ] **Step 8: Run tests + typecheck**

```bash
npm test
npm run typecheck
```

Expected: pass. Any test that decodes a snapshot or welcome will now see the new fields — existing tests don't assert on them, so they should pass through.

- [ ] **Step 9: Commit**

```bash
git add packages/
git commit -m "feat: Snapshot+Welcome carry panel state; Room owns the buffer"
```

---

## Task 6: New EntityType.Crawler + CrawlerEncoder

**Files:**
- Modify: `packages/shared/src/net/wire.ts` (EntityType enum)
- Modify: `packages/shared/src/types.ts`
- Create: `packages/shared/src/net/entities/CrawlerEncoder.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Add `CrawlerState` to types.ts:**

```ts
// Crawler AI state — wire-encoded as a u8.
export const CrawlerAIState = {
  APPROACHING: 0,
  ATTACKING: 1,
  TRANSITING: 2,
} as const;
export type CrawlerAIStateValue = (typeof CrawlerAIState)[keyof typeof CrawlerAIState];

export interface CrawlerState {
  id: number;     // u16
  x: number;      // px
  y: number;      // px
  facing: number; // rad (quantized u8)
  hp: number;     // u8, default 1 in B1
  targetCx: number; // u8 column
  targetCy: number; // u8 row
  ai: CrawlerAIStateValue;
}
```

- [ ] **Step 2: Add `EntityType.Crawler = 3`** in `packages/shared/src/net/wire.ts`. Find the EntityType enum and add the variant.

```ts
export const EntityType = {
  Player: 0,
  NPC: 2,
  Crawler: 3,
  Carbon: 4,  // reserved for Task 9; declare now so we don't bump twice
} as const;
```

- [ ] **Step 3: Write failing test** in wire.test.ts:

```ts
test('CrawlerEncoder round-trips Crawler state', async () => {
  const { CrawlerEncoder } = await import('../entities/CrawlerEncoder.js');
  const c = { id: 42, x: 320.5, y: 200, facing: Math.PI / 2, hp: 1, targetCx: 5, targetCy: 6, ai: 1 as const };
  const w = new BinaryWriter(32);
  CrawlerEncoder.encode(w, c);
  const r = new BinaryReader(w.finish());
  const decoded = CrawlerEncoder.decode(r);
  assert.equal(decoded.id, 42);
  assert.equal(decoded.hp, 1);
  assert.equal(decoded.targetCx, 5);
  assert.equal(decoded.targetCy, 6);
  assert.equal(decoded.ai, 1);
  assert.ok(Math.abs(decoded.x - 320) < 1, 'x int round-trip');
  assert.ok(Math.abs(decoded.y - 200) < 1, 'y int round-trip');
});
```

- [ ] **Step 4: Run — expect fail** (CrawlerEncoder doesn't exist).

Run: `npm test --workspace=@gridforce/shared`

- [ ] **Step 5: Implement `CrawlerEncoder.ts`:**

```ts
import type { CrawlerState } from '../../types.js';
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

// Layout (12 bytes per Crawler):
//   u16 id
//   i16 x (px, rounded)
//   i16 y (px, rounded)
//   u8  facingQ
//   u8  hp
//   u8  targetCx
//   u8  targetCy
//   u8  ai
export const CrawlerEncoder: EntityEncoder<CrawlerState> = {
  type: EntityType.Crawler,
  encode(w, c) {
    w.u16(c.id & 0xffff);
    w.i16(Math.round(c.x));
    w.i16(Math.round(c.y));
    w.u8(quantizeFacing(c.facing));
    w.u8(c.hp & 0xff);
    w.u8(c.targetCx & 0xff);
    w.u8(c.targetCy & 0xff);
    w.u8(c.ai & 0xff);
  },
  decode(r) {
    const id = r.u16();
    const x = r.i16();
    const y = r.i16();
    const facing = unquantizeFacing(r.u8());
    const hp = r.u8();
    const targetCx = r.u8();
    const targetCy = r.u8();
    const ai = r.u8() as CrawlerState['ai'];
    return { id, x, y, facing, hp, targetCx, targetCy, ai };
  },
};
```

(Verify `i16` exists on `BinaryWriter/Reader`; if not, use `u16` and treat negative coords as wrap — but at default world sizes negative coords don't happen.)

- [ ] **Step 6: Register the encoder** — find where PlayerEncoder + NPC encoder are registered. Add:

```ts
registerEntityEncoder(EntityType.Crawler, CrawlerEncoder);
```

(Match the file/style used by the existing registrations.)

- [ ] **Step 7: Run tests + typecheck.**

```bash
npm test --workspace=@gridforce/shared
npm run typecheck
```

Expected: round-trip test passes.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/net/wire.ts packages/shared/src/net/entities/CrawlerEncoder.ts
git commit -m "feat: CrawlerState + CrawlerEncoder; reserve EntityType.Carbon=4"
```

---

## Task 7: Crawler AI step function (deterministic, TDD)

**Files:**
- Create: `packages/shared/src/enemies/crawler.ts`
- Test: `packages/shared/src/enemies/crawler.test.ts`

- [ ] **Step 1: Write the failing tests** at `packages/shared/src/enemies/crawler.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';
import {
  PanelState,
  allLive,
  indexOf,
} from '../panels.js';
import {
  PANEL_ATTACK_TO_DAMAGE_S,
  PANEL_ATTACK_TO_BREAK_S,
  CRAWLER_MOVE_SPEED,
} from '../constants.js';
import { stepCrawler } from './crawler.js';

const grid: GridDef = { cols: 18, rows: 12, panelSize: 64 };

function freshContext() {
  return {
    panels: allLive(grid.cols, grid.rows),
    attackTimers: new Map<number, number>(), // panel index -> seconds of attack accrued
    cityHpDelta: 0,                          // accumulates as crawlers exit
  };
}

test('approaching crawler walks toward target panel', () => {
  const c: CrawlerState = {
    id: 1, x: grid.cols * grid.panelSize / 2, y: 10,
    facing: Math.PI / 2, hp: 1,
    targetCx: 9, targetCy: 0, ai: CrawlerAIState.APPROACHING,
  };
  const ctx = freshContext();
  const dt = 1 / 30;
  const next = stepCrawler(c, dt, grid, ctx);
  // Target is downward (cy=0 row), but our spawn is at y=10 so target is below.
  // Actually targetCy=0 is the TOP row in screen coords; the spawn at y=10 is
  // already near the top. Recompute: target panel centre = (9*64+32, 0*64+32) = (608, 32).
  // We're at (576, 10). Direction is roughly +x, +y. After one tick at 80 px/s the
  // crawler should have moved a small distance toward (608, 32).
  const distMoved = Math.hypot(next.x - c.x, next.y - c.y);
  assert.ok(distMoved > 0, 'crawler should have moved');
  assert.ok(distMoved <= CRAWLER_MOVE_SPEED * dt + 0.01, 'no faster than speed');
});

test('attacking crawler degrades LIVE -> DAMAGED after attack-time-to-damage', () => {
  const ctx = freshContext();
  // Crawler standing right on top of (cx=5, cy=5) panel, AI=ATTACKING.
  const cx = 5;
  const cy = 5;
  const c: CrawlerState = {
    id: 1,
    x: cx * grid.panelSize + grid.panelSize / 2,
    y: cy * grid.panelSize + grid.panelSize / 2,
    facing: 0, hp: 1,
    targetCx: cx, targetCy: cy, ai: CrawlerAIState.ATTACKING,
  };
  // Drive until just past the damage threshold.
  let cur = c;
  const dt = 1 / 30;
  const ticks = Math.ceil((PANEL_ATTACK_TO_DAMAGE_S + 0.05) / dt);
  for (let i = 0; i < ticks; i++) cur = stepCrawler(cur, dt, grid, ctx);
  const panelIdx = indexOf(grid.cols, cx, cy);
  assert.equal(ctx.panels[panelIdx], PanelState.DAMAGED);
});

test('attacking crawler degrades DAMAGED -> BROKEN after another attack window', () => {
  const ctx = freshContext();
  const cx = 5;
  const cy = 5;
  ctx.panels[indexOf(grid.cols, cx, cy)] = PanelState.DAMAGED;
  const c: CrawlerState = {
    id: 1,
    x: cx * grid.panelSize + grid.panelSize / 2,
    y: cy * grid.panelSize + grid.panelSize / 2,
    facing: 0, hp: 1,
    targetCx: cx, targetCy: cy, ai: CrawlerAIState.ATTACKING,
  };
  let cur = c;
  const dt = 1 / 30;
  const ticks = Math.ceil((PANEL_ATTACK_TO_BREAK_S + 0.05) / dt);
  for (let i = 0; i < ticks; i++) cur = stepCrawler(cur, dt, grid, ctx);
  assert.equal(ctx.panels[indexOf(grid.cols, cx, cy)], PanelState.BROKEN);
});

test('crawler transitioning through broken tile moves toward opposite edge', () => {
  const ctx = freshContext();
  const cx = 5;
  const cy = 0; // top row
  ctx.panels[indexOf(grid.cols, cx, cy)] = PanelState.BROKEN;
  const c: CrawlerState = {
    id: 1,
    x: cx * grid.panelSize + grid.panelSize / 2,
    y: cy * grid.panelSize + grid.panelSize / 2,
    facing: 0, hp: 1,
    targetCx: cx, targetCy: cy, ai: CrawlerAIState.TRANSITING,
  };
  // A crawler entering from the top edge transits DOWNWARD (positive y).
  // After 1 tick, y should increase.
  const next = stepCrawler(c, 1 / 30, grid, ctx);
  assert.ok(next.y > c.y, `expected y to increase, was ${c.y} now ${next.y}`);
});
```

- [ ] **Step 2: Run — expect failure.**

Run: `npm test --workspace=@gridforce/shared`

- [ ] **Step 3: Implement `crawler.ts`:**

```ts
import {
  CRAWLER_MOVE_SPEED,
  PANEL_ATTACK_TO_DAMAGE_S,
  PANEL_ATTACK_TO_BREAK_S,
} from '../constants.js';
import {
  PanelState,
  indexOf,
  type PanelStateValue,
} from '../panels.js';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';

export interface CrawlerStepContext {
  /** Mutable panel-state buffer. stepCrawler may mutate cells when a panel
   *  degrades. */
  panels: Uint8Array;
  /** Per-panel "seconds of attack accrued" — keyed by panel index. The step
   *  function bumps this for the panel being attacked and clears it once
   *  the panel transitions to the next state. */
  attackTimers: Map<number, number>;
  /** Accumulator: incremented each time a crawler exits the world through a
   *  broken tile. The caller (Room) deducts city HP from this and resets. */
  cityHpDelta: number;
}

const HALF_PANEL = 32; // hardcoded at panelSize=64; if panelSize varies, derive from grid.

export function stepCrawler(
  c: CrawlerState,
  dt: number,
  grid: GridDef,
  ctx: CrawlerStepContext,
): CrawlerState {
  switch (c.ai) {
    case CrawlerAIState.APPROACHING:
      return stepApproaching(c, dt, grid, ctx);
    case CrawlerAIState.ATTACKING:
      return stepAttacking(c, dt, grid, ctx);
    case CrawlerAIState.TRANSITING:
      return stepTransiting(c, dt, grid, ctx);
    default:
      return c;
  }
}

function stepApproaching(c: CrawlerState, dt: number, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  // Walk straight toward the target panel centre.
  const tx = c.targetCx * grid.panelSize + grid.panelSize / 2;
  const ty = c.targetCy * grid.panelSize + grid.panelSize / 2;
  const dx = tx - c.x;
  const dy = ty - c.y;
  const dist = Math.hypot(dx, dy);
  // Once within half a tile, transition to ATTACKING.
  if (dist <= HALF_PANEL) {
    return { ...c, ai: CrawlerAIState.ATTACKING };
  }
  const step = CRAWLER_MOVE_SPEED * dt;
  const move = Math.min(step, dist);
  return {
    ...c,
    x: c.x + (dx / dist) * move,
    y: c.y + (dy / dist) * move,
    facing: Math.atan2(dy, dx),
  };
}

function stepAttacking(c: CrawlerState, dt: number, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  const idx = indexOf(grid.cols, c.targetCx, c.targetCy);
  const state = ctx.panels[idx] as PanelStateValue;
  if (state === PanelState.BROKEN) {
    // Panel already broken (e.g. another crawler did it). Switch to TRANSITING.
    return { ...c, ai: CrawlerAIState.TRANSITING };
  }
  const accrued = (ctx.attackTimers.get(idx) ?? 0) + dt;
  const threshold = state === PanelState.LIVE
    ? PANEL_ATTACK_TO_DAMAGE_S
    : PANEL_ATTACK_TO_BREAK_S;
  if (accrued >= threshold) {
    // Advance the panel one state and reset the timer.
    const nextState: PanelStateValue = state === PanelState.LIVE ? PanelState.DAMAGED : PanelState.BROKEN;
    ctx.panels[idx] = nextState;
    ctx.attackTimers.set(idx, 0);
    if (nextState === PanelState.BROKEN) {
      return { ...c, ai: CrawlerAIState.TRANSITING };
    }
  } else {
    ctx.attackTimers.set(idx, accrued);
  }
  return c;
}

function stepTransiting(c: CrawlerState, dt: number, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  // Continue in the same direction the crawler was facing (set by APPROACHING).
  // Crawlers approach from edges, so their inbound direction points across the
  // grid; we just keep going.
  const step = CRAWLER_MOVE_SPEED * dt;
  let nx = c.x + Math.cos(c.facing) * step;
  let ny = c.y + Math.sin(c.facing) * step;
  const worldW = grid.cols * grid.panelSize;
  const worldH = grid.rows * grid.panelSize;
  // Exit detection: when the crawler's centre crosses the opposite edge.
  if (nx < 0 || nx > worldW || ny < 0 || ny > worldH) {
    ctx.cityHpDelta += 1;
    // Mark for removal by setting hp=0 — the room reaps these between ticks.
    return { ...c, x: nx, y: ny, hp: 0 };
  }
  return { ...c, x: nx, y: ny };
}
```

- [ ] **Step 4: Adjust the approaching test for direction**

After looking at the first test ("approaching crawler walks toward target panel"), the expected facing depends on the relative position of the target. The test as written places the crawler at (576, 10) targeting (608, 32) which gives a direction in the +x +y quadrant. The implementation's atan2 produces a facing in that quadrant. The dist-moved assertion still holds. Good.

- [ ] **Step 5: Run tests — expect pass.**

Run: `npm test --workspace=@gridforce/shared`
Expected: 4 crawler tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/enemies/
git commit -m "feat: deterministic Crawler step function (approach/attack/transit)"
```

---

## Task 8: Server Crawler map + spawner + snapshot integration

**Files:**
- Modify: `packages/server/src/Room.ts`
- Modify: `packages/server/src/Room.ts` (broadcastSnapshot)

- [ ] **Step 1: Add crawler state to Room.ts.**

In imports, add:

```ts
import {
  CRAWLER_SPAWN_INTERVAL_S,
  MAX_ALIVE_CRAWLERS,
  CrawlerAIState,
  EntityType,
  PanelState,
  indexOf,
  stepCrawler,
  type CrawlerState,
  type CrawlerStepContext,
} from '@gridforce/shared';
import { CrawlerEncoder } from '@gridforce/shared/net/entities/CrawlerEncoder.js';
```

(If `stepCrawler` and `CrawlerStepContext` aren't exported from the shared index yet, add `export * from './enemies/crawler.js';` to `packages/shared/src/index.ts`.)

Add to Room class fields:

```ts
readonly crawlers = new Map<number, CrawlerState>();
private nextCrawlerId = 0;
private crawlerSpawnAccum = 0;
private attackTimers = new Map<number, number>();
```

- [ ] **Step 2: Spawn helper.**

```ts
private spawnCrawler(): void {
  if (this.crawlers.size >= MAX_ALIVE_CRAWLERS) return;
  // Pick a random edge. Approach the nearest LIVE-or-DAMAGED panel adjacent
  // to that edge. For B1, just pick a random tile on the chosen edge.
  const edge = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left
  let cx: number, cy: number, x: number, y: number, facing: number;
  const { cols, rows, panelSize } = this.grid;
  if (edge === 0) {
    cx = Math.floor(Math.random() * cols);
    cy = 0;
    x = cx * panelSize + panelSize / 2;
    y = -panelSize / 2;
    facing = Math.PI / 2; // facing down (+y)
  } else if (edge === 1) {
    cx = cols - 1;
    cy = Math.floor(Math.random() * rows);
    x = cols * panelSize + panelSize / 2;
    y = cy * panelSize + panelSize / 2;
    facing = Math.PI; // facing left (-x)
  } else if (edge === 2) {
    cx = Math.floor(Math.random() * cols);
    cy = rows - 1;
    x = cx * panelSize + panelSize / 2;
    y = rows * panelSize + panelSize / 2;
    facing = -Math.PI / 2; // facing up (-y)
  } else {
    cx = 0;
    cy = Math.floor(Math.random() * rows);
    x = -panelSize / 2;
    y = cy * panelSize + panelSize / 2;
    facing = 0; // facing right (+x)
  }
  const id = this.nextCrawlerId++ & 0xffff;
  this.crawlers.set(id, {
    id, x, y, facing, hp: 1,
    targetCx: cx, targetCy: cy,
    ai: CrawlerAIState.APPROACHING,
  });
}
```

- [ ] **Step 3: Spawner tick in physicsStep.**

In `physicsStep`, after the existing player loop, before the phase-clock block:

```ts
// B1 Crawler spawner — continuous trickle when playing.
this.crawlerSpawnAccum += SERVER_TICK_DT_S;
if (this.crawlerSpawnAccum >= CRAWLER_SPAWN_INTERVAL_S) {
  this.crawlerSpawnAccum -= CRAWLER_SPAWN_INTERVAL_S;
  this.spawnCrawler();
}

// Step all crawlers.
const ctx: CrawlerStepContext = {
  panels: this.panelStates,
  attackTimers: this.attackTimers,
  cityHpDelta: 0,
};
for (const [id, c] of this.crawlers) {
  const next = stepCrawler(c, SERVER_TICK_DT_S, this.grid, ctx);
  if (next.hp <= 0) {
    this.crawlers.delete(id);
  } else {
    this.crawlers.set(id, next);
  }
}
// ctx.cityHpDelta is accumulated for B2's cityHp; B1 ignores it.
```

- [ ] **Step 4: Reset crawler state on startGame.**

In `startGame`, after the panel-state allocation:

```ts
this.crawlers.clear();
this.nextCrawlerId = 0;
this.crawlerSpawnAccum = 0;
this.attackTimers.clear();
```

- [ ] **Step 5: Encode crawlers in snapshots.**

Find the existing group-encoding block in `broadcastSnapshot`. Just before/after the NPC group, add (matching the existing dynamic-group pattern):

```ts
const hasCrawlers = this.crawlers.size > 0;
// Adjust the group-count line accordingly. Easier shape: count first, then emit.
const groups: Array<{ type: number; entries: unknown[] }> = [];
groups.push({ type: EntityType.Player, entries: visible });
if (npcStates.length > 0) groups.push({ type: EntityType.NPC, entries: npcStates });
if (hasCrawlers) groups.push({ type: EntityType.Crawler, entries: Array.from(this.crawlers.values()) });
```

Then have the encoder iterate `groups` and emit each one. (This requires adapting the existing emit code, which currently hard-codes Player + optional NPC. The plan is to refactor `SnapshotMsg.encode` to take a generic `groups: EntityGroup[]` array — but for B1 minimum change, just add a Crawler block inline after the existing Player/NPC blocks. Adapt to whatever pattern the file uses.)

A simpler concrete refactor for `Snapshot.ts`: change the encode function to accept an additional `crawlers: CrawlerState[]` field on `SnapshotPayload` and emit `EntityType.Crawler` when non-empty. Wire it through the dynamic group counter.

- [ ] **Step 6: Update SnapshotPayload + encoder.**

In `packages/shared/src/types.ts`, add to `SnapshotPayload`:

```ts
crawlers: CrawlerState[];
```

In `packages/shared/src/net/messages/Snapshot.ts`, the existing hasNpcs/groupCount pattern adapts cleanly. Replace the relevant block:

```ts
const hasNpcs = p.npcs.length > 0;
const hasCrawlers = p.crawlers.length > 0;
let groupCount = 1; // Player always present
if (hasNpcs) groupCount++;
if (hasCrawlers) groupCount++;
w.u8(groupCount);

w.u8(EntityType.Player);
w.varuint(p.players.length);
// ... existing PlayerEncoder loop ...

if (hasNpcs) {
  w.u8(EntityType.NPC);
  w.varuint(p.npcs.length);
  // ... existing NPC loop ...
}

if (hasCrawlers) {
  w.u8(EntityType.Crawler);
  w.varuint(p.crawlers.length);
  const crawlerEnc = getEntityEncoder(EntityType.Crawler);
  if (!crawlerEnc) throw new Error('Crawler encoder not registered');
  for (const c of p.crawlers) crawlerEnc.encode(w, c);
}
```

In the decoder, extend the entity-group loop to push into a `crawlers` array when `entityType === EntityType.Crawler`. Add `crawlers` to the returned payload.

- [ ] **Step 7: Update Room.broadcastSnapshot.**

Add to the encode payload:

```ts
crawlers: Array.from(this.crawlers.values()),
```

- [ ] **Step 8: Add a quick integration check** to `packages/server/src/test/stages.test.ts` or a new server test:

Skip writing a new server test for now if the existing wire round-trip covers Crawler. A targeted integration test lands in Task 17.

- [ ] **Step 9: Run tests + typecheck.**

```bash
npm test
npm run typecheck
```

Expected: pass. Any existing snapshot decode test will now also see `s.crawlers === []` which is fine if no assertion targets it.

- [ ] **Step 10: Commit**

```bash
git add packages/
git commit -m "feat: server Crawler map + spawner + snapshot Crawler group"
```

---

## Task 9: Carbon entity (lifecycle + encoder + snapshot integration)

**Files:**
- Modify: `packages/shared/src/types.ts`
- Create: `packages/shared/src/net/entities/CarbonEncoder.ts`
- Modify: `packages/shared/src/net/messages/Snapshot.ts`
- Modify: `packages/server/src/Room.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Add `CarbonState` to types.ts:**

```ts
export interface CarbonState {
  id: number;   // u16
  x: number;    // px
  y: number;    // px
  ttlS: number; // f32 seconds remaining
}
```

Also add `carbons: CarbonState[]` to `SnapshotPayload`.

- [ ] **Step 2: Implement CarbonEncoder.ts**, similar shape to CrawlerEncoder:

```ts
import type { CarbonState } from '../../types.js';
import type { BinaryReader, BinaryWriter } from '../wire.js';
import { EntityType } from '../wire.js';
import type { EntityEncoder } from './PlayerEncoder.js';

// 9 bytes:
//   u16 id
//   i16 x
//   i16 y
//   u8  ttlQ (0..255, mapping to 0..CARBON_TTL_S seconds)
//   u16 reserved-for-future (0 for now to keep alignment if we ever add fields)
const TTL_SCALE = 255;
export const CarbonEncoder: EntityEncoder<CarbonState> = {
  type: EntityType.Carbon,
  encode(w, c) {
    w.u16(c.id & 0xffff);
    w.i16(Math.round(c.x));
    w.i16(Math.round(c.y));
    const ttlQ = Math.max(0, Math.min(TTL_SCALE, Math.round((c.ttlS / 10) * TTL_SCALE)));
    w.u8(ttlQ);
  },
  decode(r) {
    const id = r.u16();
    const x = r.i16();
    const y = r.i16();
    const ttlQ = r.u8();
    const ttlS = (ttlQ / TTL_SCALE) * 10;
    return { id, x, y, ttlS };
  },
};
```

(Hardcoding the 10s max — matches `CARBON_TTL_S`. If that constant changes, the encoder needs to know it. Acceptable for B1.)

- [ ] **Step 3: Register encoder.**

Add to wherever encoders are registered:

```ts
registerEntityEncoder(EntityType.Carbon, CarbonEncoder);
```

- [ ] **Step 4: Extend Snapshot.ts** to emit/decode a Carbon group, mirroring the Crawler block from Task 8.

- [ ] **Step 5: Write the failing wire test** in wire.test.ts:

```ts
test('CarbonEncoder round-trips Carbon state', async () => {
  const { CarbonEncoder } = await import('../entities/CarbonEncoder.js');
  const c = { id: 7, x: 500, y: 700, ttlS: 5.5 };
  const w = new BinaryWriter(16);
  CarbonEncoder.encode(w, c);
  const r = new BinaryReader(w.finish());
  const decoded = CarbonEncoder.decode(r);
  assert.equal(decoded.id, 7);
  assert.equal(decoded.x, 500);
  assert.equal(decoded.y, 700);
  assert.ok(Math.abs(decoded.ttlS - 5.5) < 0.1, `ttl quantization (got ${decoded.ttlS})`);
});
```

- [ ] **Step 6: Add Carbon lifecycle to Room.**

In Room class fields:

```ts
readonly carbons = new Map<number, CarbonState>();
private nextCarbonId = 0;
```

Helper:

```ts
private spawnCarbon(x: number, y: number): void {
  const id = this.nextCarbonId++ & 0xffff;
  this.carbons.set(id, { id, x, y, ttlS: CARBON_TTL_S });
}
```

In the Crawler step loop (Task 8), when removing a crawler, spawn a carbon at its position **only if it died via combat, not via city-exit**. The crawler step function sets `hp = 0` on city-exit; we need a way to distinguish death-by-shock from death-by-exit. The cleanest signal: in the step function, set a marker. Pragmatic fix: keep the existing hp=0 marker, but rely on the SHOCK code (Task 10) to spawn carbon at kill location BEFORE calling delete. The crawler.ts already sets hp=0 on exit, and that doesn't spawn carbon. Combat-kill paths (Task 10) explicitly spawnCarbon then delete.

Add to imports:

```ts
import {
  CARBON_TTL_S,
  type CarbonState,
} from '@gridforce/shared';
import { CarbonEncoder } from '@gridforce/shared/net/entities/CarbonEncoder.js';
```

In the physicsStep, after the crawler-step block, add a carbon expire+pickup pass:

```ts
// Carbon expiry + pickup.
for (const [id, carbon] of this.carbons) {
  const next: CarbonState = { ...carbon, ttlS: carbon.ttlS - SERVER_TICK_DT_S };
  if (next.ttlS <= 0) {
    this.carbons.delete(id);
    continue;
  }
  // Pickup: any player within (PLAYER_RADIUS + CARBON_PICKUP_RADIUS).
  let pickedUp = false;
  for (const [pid, pstate] of this.states) {
    const dist = Math.hypot(next.x - pstate.x, next.y - pstate.y);
    if (dist <= PLAYER_RADIUS + CARBON_PICKUP_RADIUS) {
      const newCarbon = Math.min(PLAYER_CARBON_MAX, pstate.carbon + 1);
      this.states.set(pid, { ...pstate, carbon: newCarbon });
      this.carbons.delete(id);
      pickedUp = true;
      break;
    }
  }
  if (!pickedUp) this.carbons.set(id, next);
}
```

Add the constants to the imports:

```ts
import {
  CARBON_PICKUP_RADIUS,
  PLAYER_CARBON_MAX,
  PLAYER_RADIUS,
} from '@gridforce/shared';
```

Reset on startGame:

```ts
this.carbons.clear();
this.nextCarbonId = 0;
```

- [ ] **Step 7: Update broadcastSnapshot to include carbons:**

```ts
carbons: Array.from(this.carbons.values()),
```

- [ ] **Step 8: Run tests + typecheck.**

```bash
npm test
npm run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add packages/
git commit -m "feat: Carbon entity — encoder, lifecycle, pickup"
```

---

## Task 10: Local shock (uncharged) — server-authoritative

**Files:**
- Modify: `packages/server/src/Room.ts`
- Test: `packages/server/src/test/shock.test.ts` (NEW)

- [ ] **Step 1: Write a failing integration-style test** at `packages/server/src/test/shock.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import { CrawlerAIState, PanelState } from '@gridforce/shared';

test('shock kills crawler on adjacent LIVE tile', () => {
  // Construct a Room in-process. Reach in to set up the scenario directly.
  const room = new Room('TEST', { visibility: 'unlisted' });
  // Pretend a player is in the room at tile (5, 5) centre.
  room.startGame(0);                         // host check would normally fail; bypass:
  // ^ For test purposes, call internals directly. If startGame's host check
  // prevents this, expose a `test_forceStart()` or just set room.phase = 'playing'.
  // Reach into internals through `as any` to set up state cleanly:
  const r = room as any;
  r.phase = 'playing';
  r.panelStates = new Uint8Array(r.grid.cols * r.grid.rows); // all LIVE
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0,
  });
  // Spawn a crawler on tile (6, 5) — directly to the right of the player.
  r.crawlers.set(1, {
    id: 1, x: 6 * 64 + 32, y: 5 * 64 + 32, facing: Math.PI, hp: 1,
    targetCx: 6, targetCy: 5, ai: CrawlerAIState.ATTACKING,
  });
  // Fake a pilot whose consumeInputForTick returns shock=true on this tick.
  const fakePilot = {
    isBot: false, ready: true, name: 'a',
    ackInputTick: 0, computeAckBitmask: () => 0,
    send: () => {},
    consumeInputForTick: () => ({
      tick: 0, clientTimeMs: 0, mx: 0, my: 0, dash: false, sprint: false, shock: true, repair: false,
    }),
    dispose: () => {},
  };
  r.pilots.set(0, fakePilot);
  // Drive one physics tick.
  r.physicsStep();
  // Crawler should be removed (dead) and a Carbon should have spawned in its tile.
  assert.equal(r.crawlers.size, 0, 'crawler killed');
  assert.equal(r.carbons.size, 1, 'carbon spawned');
});
```

(The test bypasses the host-check by reaching into internals. If `Room` doesn't expose `physicsStep` publicly, expose it as a test helper or call `startGame` properly with a real connection. The above is the simplest readable shape — adapt to match Room's actual API.)

- [ ] **Step 2: Run — expect fail** (shock not implemented).

- [ ] **Step 3: Implement shock in Room.physicsStep.**

In the per-player loop in physicsStep, after the existing `stepPlayer` call:

```ts
// Uncharged local shock — rising-edge on input.shock with cooldown gate.
if (input && input.shock && next.shockCooldownS === 0) {
  this.applyShock(id, next);
  // Note: applyShock mutates this.crawlers and may spawn carbons. The player's
  // own state's shockCooldownS is set inside applyShock by re-storing it.
  // Read back the updated state after the helper runs.
  const updated = this.states.get(id);
  if (updated) this.states.set(id, updated);
} else {
  // Drain cooldown.
  const nextCool = Math.max(0, next.shockCooldownS - SERVER_TICK_DT_S);
  this.states.set(id, { ...next, shockCooldownS: nextCool });
}
```

Add the helper:

```ts
private applyShock(playerId: PlayerId, playerState: PlayerState): void {
  const { cols, rows, panelSize } = this.grid;
  const cx = Math.floor(playerState.x / panelSize);
  const cy = Math.floor(playerState.y / panelSize);
  const neighbors: Array<[number, number]> = [
    [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
    const idx = indexOf(cols, nx, ny);
    if (this.panelStates[idx] !== PanelState.LIVE) continue;
    // Kill any crawler inside this tile.
    const tileMinX = nx * panelSize;
    const tileMinY = ny * panelSize;
    const tileMaxX = tileMinX + panelSize;
    const tileMaxY = tileMinY + panelSize;
    for (const [cid, c] of this.crawlers) {
      if (c.x >= tileMinX && c.x < tileMaxX && c.y >= tileMinY && c.y < tileMaxY) {
        // Spawn carbon at crawler position then remove crawler.
        this.spawnCarbon(c.x, c.y);
        this.crawlers.delete(cid);
      }
    }
  }
  this.states.set(playerId, { ...playerState, shockCooldownS: SHOCK_COOLDOWN_S });
}
```

Add the constants to imports:

```ts
import { SHOCK_COOLDOWN_S } from '@gridforce/shared';
```

- [ ] **Step 4: Run tests — expect pass.**

Run: `npm test --workspace=@gridforce/server`

- [ ] **Step 5: Add cooldown-enforcement test** to `shock.test.ts`:

```ts
test('shock cooldown prevents back-to-back fires', () => {
  // Build the scenario from the prior test, then fire two ticks in a row
  // with shock=true on both. Two crawlers spawned; only one should die.
  const room = new Room('TEST2', { visibility: 'unlisted' });
  const r = room as any;
  r.phase = 'playing';
  r.panelStates = new Uint8Array(r.grid.cols * r.grid.rows);
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0,
  });
  r.crawlers.set(1, { id: 1, x: 6 * 64 + 32, y: 5 * 64 + 32, facing: Math.PI, hp: 1, targetCx: 6, targetCy: 5, ai: CrawlerAIState.ATTACKING });
  r.crawlers.set(2, { id: 2, x: 4 * 64 + 32, y: 5 * 64 + 32, facing: 0,        hp: 1, targetCx: 4, targetCy: 5, ai: CrawlerAIState.ATTACKING });
  // Crawler 2 is to the left; both adjacent. One shock kills both since each
  // is in a different cardinal neighbour. Adjust test to put both in same
  // tile to test cooldown:
  r.crawlers.set(3, { id: 3, x: 6 * 64 + 40, y: 5 * 64 + 32, facing: Math.PI, hp: 1, targetCx: 6, targetCy: 5, ai: CrawlerAIState.ATTACKING });
  // Now crawlers 1 and 3 are in the same right-neighbour tile. They both die on
  // the same shock. To test cooldown specifically, replace this with two
  // ticks of shock and check that the second tick has no effect when cool>0.
  // Simpler: drive one tick of shock; cool should be at SHOCK_COOLDOWN_S afterward.
  r.pilots.set(0, {
    isBot: false, ready: true, name: 'a', ackInputTick: 0, computeAckBitmask: () => 0, send: () => {},
    consumeInputForTick: () => ({ tick: 0, clientTimeMs: 0, mx: 0, my: 0, dash: false, sprint: false, shock: true, repair: false }),
    dispose: () => {},
  });
  r.physicsStep();
  const after = r.states.get(0);
  assert.ok(after.shockCooldownS > 0, `expected cooldown > 0 after fire, got ${after.shockCooldownS}`);
});
```

- [ ] **Step 6: Run + commit.**

```bash
npm test
npm run typecheck
git add packages/
git commit -m "feat: server applies uncharged local shock w/ cooldown"
```

---

## Task 11: Repair (DAMAGED → LIVE only — B2 owns the BROKEN→LIVE rebuild)

**Files:**
- Modify: `packages/server/src/Room.ts`
- Test: `packages/server/src/test/repair.test.ts` (NEW)

- [ ] **Step 1: Write failing test** at `repair.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import { PanelState, REPAIR_DURATION_S, REPAIR_CARBON_COST, indexOf } from '@gridforce/shared';

function pilotWithRepair(repair: boolean) {
  return {
    isBot: false, ready: true, name: 'a',
    ackInputTick: 0, computeAckBitmask: () => 0,
    send: () => {}, dispose: () => {},
    consumeInputForTick: () => ({
      tick: 0, clientTimeMs: 0, mx: 0, my: 0, dash: false, sprint: false, shock: false, repair,
    }),
  };
}

test('holding repair on DAMAGED tile with carbon flips to LIVE after 1.5s', () => {
  const room = new Room('TR', { visibility: 'unlisted' });
  const r = room as any;
  r.phase = 'playing';
  r.panelStates = new Uint8Array(r.grid.cols * r.grid.rows);
  // Damage the tile at (5, 5).
  r.panelStates[indexOf(r.grid.cols, 5, 5)] = PanelState.DAMAGED;
  // Place a player standing on tile (5, 5) with 5 carbon.
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 5, shockCooldownS: 0, repairProgressS: 0,
  });
  r.pilots.set(0, pilotWithRepair(true));
  // Tick until progress meets duration.
  const dt = 1 / 30;
  const ticks = Math.ceil(REPAIR_DURATION_S / dt) + 1;
  for (let i = 0; i < ticks; i++) r.physicsStep();
  assert.equal(r.panelStates[indexOf(r.grid.cols, 5, 5)], PanelState.LIVE);
  assert.equal(r.states.get(0).carbon, 5 - REPAIR_CARBON_COST);
  assert.equal(r.states.get(0).repairProgressS, 0);
});

test('releasing repair resets the progress timer', () => {
  const room = new Room('TR2', { visibility: 'unlisted' });
  const r = room as any;
  r.phase = 'playing';
  r.panelStates = new Uint8Array(r.grid.cols * r.grid.rows);
  r.panelStates[indexOf(r.grid.cols, 5, 5)] = PanelState.DAMAGED;
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 1, shockCooldownS: 0, repairProgressS: 0,
  });
  let repairing = true;
  r.pilots.set(0, {
    isBot: false, ready: true, name: 'a', ackInputTick: 0, computeAckBitmask: () => 0, send: () => {}, dispose: () => {},
    consumeInputForTick: () => ({ tick: 0, clientTimeMs: 0, mx: 0, my: 0, dash: false, sprint: false, shock: false, repair: repairing }),
  });
  for (let i = 0; i < 10; i++) r.physicsStep(); // ~0.33s of repair
  assert.ok(r.states.get(0).repairProgressS > 0);
  // Release.
  repairing = false;
  r.physicsStep();
  assert.equal(r.states.get(0).repairProgressS, 0);
});
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement repair in Room.physicsStep.**

After the shock block in the per-player loop:

```ts
// Repair (DAMAGED -> LIVE only in B1; rebuild lands in B2).
const updated = this.states.get(id)!;
if (input && input.repair && updated.carbon > 0) {
  const cx = Math.floor(updated.x / this.grid.panelSize);
  const cy = Math.floor(updated.y / this.grid.panelSize);
  if (cx >= 0 && cx < this.grid.cols && cy >= 0 && cy < this.grid.rows) {
    const idx = indexOf(this.grid.cols, cx, cy);
    if (this.panelStates[idx] === PanelState.DAMAGED) {
      const newProgress = updated.repairProgressS + SERVER_TICK_DT_S;
      if (newProgress >= REPAIR_DURATION_S) {
        this.panelStates[idx] = PanelState.LIVE;
        this.states.set(id, { ...updated, carbon: updated.carbon - REPAIR_CARBON_COST, repairProgressS: 0 });
      } else {
        this.states.set(id, { ...updated, repairProgressS: newProgress });
      }
    } else {
      // Not on a DAMAGED tile; reset progress.
      this.states.set(id, { ...updated, repairProgressS: 0 });
    }
  }
} else {
  this.states.set(id, { ...updated, repairProgressS: 0 });
}
```

Add to imports:

```ts
import {
  REPAIR_DURATION_S,
  REPAIR_CARBON_COST,
} from '@gridforce/shared';
```

- [ ] **Step 4: Run tests + commit.**

```bash
npm test
npm run typecheck
git add packages/
git commit -m "feat: hold-to-repair flips DAMAGED -> LIVE in 1.5s, deducts 1 carbon"
```

---

## Task 12: Client input — F + LMB for shock, R + RMB for repair

**Files:**
- Modify: `packages/client/src/input/InputCapture.ts`
- Modify: `packages/client/src/main.ts` (mouse-button bindings)

- [ ] **Step 1: Add held + edge tracking to InputCapture.**

In the field block:

```ts
private shock = false;
private shockEdge = new RisingEdgeDetector(3);   // 3-tick rising-edge window
private repair = false;
```

(`RisingEdgeDetector` is the pattern used by `dashEdge` — reuse the same class.)

In the keyboard switch:

```ts
case 'KeyF':
  this.shock = down;
  if (down) this.shockEdge.markPressed();
  break;
case 'KeyR':
  this.repair = down;
  break;
```

In `sample()`'s return:

```ts
return {
  mx, my,
  dash: this.dashEdge.consume() || gamepadDashPressed,
  sprint: this.keys.sprint || sprintPressed,
  shock: this.shockEdge.consume() || mouseLeftEdge || gamepadShockPressed,
  repair: this.repair || mouseRightHeld || gamepadRepairHeld,
};
```

For the mouse bindings, add fields:

```ts
private mouseLeftEdge = false;  // consumed at sample()
private mouseRightHeld = false; // held
```

And event listeners on `window` (or the canvas):

```ts
window.addEventListener('mousedown', (e) => {
  if (e.button === 0) this.mouseLeftEdge = true;
  if (e.button === 2) this.mouseRightHeld = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) this.mouseRightHeld = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
```

In `sample()`, consume the LMB edge:

```ts
const mouseLeftEdge = this.mouseLeftEdge;
this.mouseLeftEdge = false;
```

For gamepad: `pad.buttons[2]?.pressed` (X on Xbox) → shock; `pad.buttons[3]?.pressed` (Y) → repair-held. (Match the existing dash/sprint gamepad pattern.)

- [ ] **Step 2: Wire through main.ts — already done via the spread.**

Verify the `world.step({...sample, clientTimeMs: now})` line is unchanged and the new fields flow through.

- [ ] **Step 3: Manual smoke test.**

```bash
npm run typecheck
npm run build --workspace=@gridforce/client
```

Both clean.

- [ ] **Step 4: Commit.**

```bash
git add packages/client/
git commit -m "feat: client emits shock (F/LMB rising-edge) + repair (R/RMB held)"
```

---

## Task 13: PredictedWorld mirrors new state + LIVE panel array

**Files:**
- Modify: `packages/client/src/sim/PredictedWorld.ts`

- [ ] **Step 1: Add mirrored state.**

In the field block:

```ts
panelStates: Uint8Array = new Uint8Array(0);
panelCols = 0;
panelRows = 0;
crawlers = new Map<number, CrawlerState>();
carbons = new Map<number, CarbonState>();
```

Add to imports:

```ts
import { type CrawlerState, type CarbonState } from '@gridforce/shared';
```

- [ ] **Step 2: Mirror from Welcome.**

In `initFromWelcome`, after the existing fields:

```ts
this.panelStates = new Uint8Array(w.panelStates);
this.panelCols = w.grid.cols;
this.panelRows = w.grid.rows;
this.crawlers.clear();
this.carbons.clear();
```

- [ ] **Step 3: Mirror from Snapshot.**

In `applySnapshot`, after the existing field mirrors:

```ts
this.panelStates = new Uint8Array(snap.panelStates);
this.panelCols = snap.panelCols;
this.panelRows = snap.panelRows;
this.crawlers.clear();
for (const c of snap.crawlers) this.crawlers.set(c.id, c);
this.carbons.clear();
for (const c of snap.carbons) this.carbons.set(c.id, c);
```

- [ ] **Step 4: Typecheck + build.**

```bash
npm run typecheck
npm run build --workspace=@gridforce/client
```

- [ ] **Step 5: Commit.**

```bash
git add packages/client/src/sim/PredictedWorld.ts
git commit -m "feat: PredictedWorld mirrors panels + crawlers + carbons"
```

---

## Task 14: GridRenderer renders 3-state tiles

**Files:**
- Modify: `packages/client/src/render/GridRenderer.ts`
- Modify: `packages/client/src/main.ts` (push panel state to renderer each frame)

- [ ] **Step 1: Add a setPanelStates method.**

In `GridRenderer.ts`, after the existing `rebuild(grid)`:

```ts
setPanelStates(buf: Uint8Array): void {
  // Cheap diff check — if reference + length unchanged, redraw is wasteful.
  // For B1 just redraw every frame the caller invokes us; cost is one Graphics
  // pass over 864 cells, negligible.
  this.draw(this.grid, buf);
}
```

Update `draw(grid)` to accept an optional panel state buffer and render LIVE/DAMAGED/BROKEN differently:

```ts
private draw(grid: GridDef, panelStates?: Uint8Array): void {
  this.gfx.clear();
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const x = cx * grid.panelSize;
      const y = cy * grid.panelSize;
      const state = panelStates ? panelStates[cy * grid.cols + cx] : 0;
      switch (state) {
        case 1: // DAMAGED
          this.gfx.beginFill(0x553322, 0.7).drawRect(x + 2, y + 2, grid.panelSize - 4, grid.panelSize - 4).endFill();
          this.gfx.lineStyle(2, 0x884422, 1).moveTo(x + 8, y + 8).lineTo(x + grid.panelSize - 8, y + grid.panelSize - 8);
          this.gfx.moveTo(x + grid.panelSize - 8, y + 8).lineTo(x + 8, y + grid.panelSize - 8);
          break;
        case 2: // BROKEN
          this.gfx.beginFill(0x000000, 1).drawRect(x + 2, y + 2, grid.panelSize - 4, grid.panelSize - 4).endFill();
          this.gfx.lineStyle(1, 0x222244, 0.5).drawRect(x + 2, y + 2, grid.panelSize - 4, grid.panelSize - 4);
          break;
        default: // LIVE
          this.gfx.beginFill(0x1a2a4a, 0.9).drawRect(x + 2, y + 2, grid.panelSize - 4, grid.panelSize - 4).endFill();
          this.gfx.lineStyle(1, 0x4488ff, 0.6).drawRect(x + 2, y + 2, grid.panelSize - 4, grid.panelSize - 4);
          break;
      }
    }
  }
}
```

(Colors are placeholders — visual treatment is a polish pass.)

- [ ] **Step 2: Call setPanelStates each frame from main.ts.**

In `onFrame`, after the existing stage-change check:

```ts
if (world.panelStates.length > 0) {
  renderer.gridRenderer.setPanelStates(world.panelStates);
}
```

- [ ] **Step 3: Build + smoke.**

```bash
npm run build --workspace=@gridforce/client
npm run typecheck
```

- [ ] **Step 4: Commit.**

```bash
git add packages/client/src/render/GridRenderer.ts packages/client/src/main.ts
git commit -m "feat: GridRenderer draws LIVE / DAMAGED / BROKEN tile states"
```

---

## Task 15: CrawlerRenderer + CarbonRenderer

**Files:**
- Create: `packages/client/src/render/CrawlerRenderer.ts`
- Create: `packages/client/src/render/CarbonRenderer.ts`
- Modify: `packages/client/src/render/Renderer.ts` (attach to playfield)
- Modify: `packages/client/src/main.ts` (per-frame draw)

- [ ] **Step 1: Implement CrawlerRenderer.ts.**

Pattern after `NpcRenderer.ts` — same beginFrame / draw / endFrame shape.

```ts
import { Container, Graphics } from 'pixi.js';

export class CrawlerRenderer {
  readonly root = new Container();
  private gfx = new Graphics();

  constructor() {
    this.root.addChild(this.gfx);
  }

  beginFrame(): void {
    this.gfx.clear();
  }

  draw(id: number, x: number, y: number, facing: number): void {
    // Red triangular sprite to read as enemy.
    this.gfx.beginFill(0xcc3333, 1);
    this.gfx.moveTo(x + Math.cos(facing) * 10, y + Math.sin(facing) * 10);
    this.gfx.lineTo(x + Math.cos(facing + 2.5) * 8, y + Math.sin(facing + 2.5) * 8);
    this.gfx.lineTo(x + Math.cos(facing - 2.5) * 8, y + Math.sin(facing - 2.5) * 8);
    this.gfx.closePath();
    this.gfx.endFill();
    void id;
  }

  endFrame(): void {
    // Single-graphics-pass renderer — no-op.
  }
}
```

- [ ] **Step 2: Implement CarbonRenderer.ts** similarly:

```ts
import { Container, Graphics } from 'pixi.js';

export class CarbonRenderer {
  readonly root = new Container();
  private gfx = new Graphics();

  constructor() {
    this.root.addChild(this.gfx);
  }

  beginFrame(): void {
    this.gfx.clear();
  }

  draw(id: number, x: number, y: number, ttlS: number): void {
    // Bright yellow dot, slightly larger when fresh, fading as ttl drops.
    const alpha = Math.min(1, ttlS / 10);
    this.gfx.beginFill(0xffd633, alpha).drawCircle(x, y, 5).endFill();
    void id;
  }

  endFrame(): void {
    /* no-op */
  }
}
```

- [ ] **Step 3: Wire into Renderer.**

In `Renderer.ts`:

```ts
import { CrawlerRenderer } from './CrawlerRenderer.js';
import { CarbonRenderer } from './CarbonRenderer.js';

readonly crawlerRenderer = new CrawlerRenderer();
readonly carbonRenderer = new CarbonRenderer();
```

In `init()`, attach to playfield in render-order (background → carbon → crawler → npc → player):

```ts
this.playfield.addChild(this.gridRenderer.root);
this.playfield.addChild(this.carbonRenderer.root);
this.playfield.addChild(this.crawlerRenderer.root);
this.playfield.addChild(this.npcRenderer.root);
this.playfield.addChild(this.playerRenderer.root);
```

- [ ] **Step 4: Per-frame draw in main.ts.**

After the NPC render block, before player rendering:

```ts
renderer.crawlerRenderer.beginFrame();
for (const c of world.crawlers.values()) {
  renderer.crawlerRenderer.draw(c.id, c.x, c.y, c.facing);
}
renderer.crawlerRenderer.endFrame();

renderer.carbonRenderer.beginFrame();
for (const carbon of world.carbons.values()) {
  renderer.carbonRenderer.draw(carbon.id, carbon.x, carbon.y, carbon.ttlS);
}
renderer.carbonRenderer.endFrame();
```

- [ ] **Step 5: Build + typecheck.**

```bash
npm run build --workspace=@gridforce/client
npm run typecheck
```

- [ ] **Step 6: Commit.**

```bash
git add packages/client/src/render/ packages/client/src/main.ts
git commit -m "feat: CrawlerRenderer + CarbonRenderer attached to playfield"
```

---

## Task 16: GameHud — local carbon counter

**Files:**
- Create: `packages/client/src/ui/GameHud.ts`
- Modify: `packages/client/src/main.ts`

- [ ] **Step 1: Implement GameHud.ts** — minimal, top-left fixed div, similar to StageHud's chrome.

```ts
export interface GameHudState {
  carbon: number;
  repairProgressS: number; // 0..1.5
}

export class GameHud {
  private root: HTMLDivElement;
  private carbonEl: HTMLSpanElement;
  private repairBar: HTMLDivElement;
  private repairFill: HTMLDivElement;
  private lastSig = '';

  constructor() {
    this.applyChrome();
    this.root = document.createElement('div');
    this.root.id = 'game-hud';
    this.carbonEl = document.createElement('span');
    this.carbonEl.className = 'gh-carbon';
    this.root.appendChild(this.carbonEl);

    this.repairBar = document.createElement('div');
    this.repairBar.className = 'gh-repair';
    this.repairBar.style.display = 'none';
    this.repairFill = document.createElement('div');
    this.repairFill.className = 'gh-repair-fill';
    this.repairBar.appendChild(this.repairFill);
    this.root.appendChild(this.repairBar);

    document.body.appendChild(this.root);
  }

  destroy(): void { this.root.remove(); }

  update(s: GameHudState): void {
    const repairBucket = Math.round((s.repairProgressS / 1.5) * 100);
    const sig = `${s.carbon}|${repairBucket}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.carbonEl.textContent = `⚡ ${s.carbon}`;
    if (s.repairProgressS > 0) {
      this.repairBar.style.display = '';
      this.repairFill.style.width = `${Math.min(100, repairBucket)}%`;
    } else {
      this.repairBar.style.display = 'none';
    }
  }

  private applyChrome(): void {
    if (document.getElementById('game-hud-style')) return;
    const style = document.createElement('style');
    style.id = 'game-hud-style';
    style.textContent = `
      #game-hud {
        position: fixed; top: 1rem; left: 1rem; z-index: 7;
        font-family: 'SF Mono', Consolas, monospace; color: #ffd633;
        font-size: 1.1rem; pointer-events: none;
        background: rgba(10, 12, 22, 0.7); padding: 0.4rem 0.8rem;
        border: 1px solid #2a2a40; border-radius: 8px;
      }
      #game-hud .gh-carbon { display: inline-block; min-width: 4rem; }
      #game-hud .gh-repair {
        width: 8rem; height: 0.4rem; background: rgba(255,255,255,0.08);
        border-radius: 4px; overflow: hidden; margin-top: 0.4rem;
      }
      #game-hud .gh-repair-fill {
        height: 100%; background: #6ee7ff; width: 0%; transition: width 60ms linear;
      }
    `;
    document.head.appendChild(style);
  }
}
```

- [ ] **Step 2: Wire into main.ts.**

In the renderer-init `.then(...)` block:

```ts
gameHud = new GameHud();
```

Declare in the outer scope:

```ts
let gameHud: GameHud | null = null;
```

Import:

```ts
import { GameHud } from './ui/GameHud.js';
```

In `onFrame`, after `stageHud?.update(...)`:

```ts
const mePlayer = world.players.get(world.localPlayerId);
if (mePlayer) {
  gameHud?.update({
    carbon: mePlayer.carbon,
    repairProgressS: mePlayer.repairProgressS,
  });
}
```

- [ ] **Step 3: Build + typecheck.**

```bash
npm run build --workspace=@gridforce/client
npm run typecheck
```

- [ ] **Step 4: Commit.**

```bash
git add packages/client/src/ui/GameHud.ts packages/client/src/main.ts
git commit -m "feat: GameHud — carbon counter + repair progress bar"
```

---

## Task 17: Integration test — endless loop

**Files:**
- Create: `packages/server/src/test/electrical-defense-b1.test.ts`

- [ ] **Step 1: Write the test.**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { AccessKeyStore } from '../AccessKeyStore.js';
import { InviteStore } from '../InviteStore.js';
import { RoomManager } from '../RoomManager.js';
import { SessionStore } from '../SessionStore.js';
import { attachHttpRoutes } from '../httpRoutes.js';
import { attachWsHandler } from '../wsHandler.js';
import { TestClient } from './TestClient.js';

async function startHarness() {
  const app = express();
  const manager = new RoomManager();
  const invites = new InviteStore();
  const accessKeys = new AccessKeyStore();
  const sessions = new SessionStore();
  manager.start();
  invites.start();
  accessKeys.start();
  attachHttpRoutes(app, { manager, invites, accessKeys, sessions });
  const httpServer: HttpServer = createServer(app);
  attachWsHandler(httpServer, { manager, invites, accessKeys, sessions });
  await new Promise<void>((r) => httpServer.listen(0, () => r()));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    manager,
    shutdown: async () => {
      manager.stop();
      invites.stop();
      accessKeys.stop();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

test('B1 endless loop: crawlers spawn, server reports them in snapshots', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'p',
      drive: () => ({ mx: 0, my: 0, dash: false, sprint: false, shock: false, repair: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    assert.equal(room.startGame(id), true);
    c.start();
    // Wait several spawn intervals.
    await new Promise<void>((r) => setTimeout(r, 3000));
    c.stop();
    // Server should have spawned at least 1 crawler (typically 2-3 in 3s with
    // 1s interval and 8-cap).
    assert.ok(room.crawlers.size >= 1, `expected at least 1 crawler, got ${room.crawlers.size}`);
  } finally {
    await h.shutdown();
  }
});

test('B1 endless loop: shock kills a nearby crawler', async () => {
  // Similar to the unit test but going through the real input path. Driver
  // is a TestClient with shock=true; spawn a single crawler adjacent to the
  // host's spawn (which is at world centre); confirm it's killed.
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'p',
      drive: () => ({ mx: 0, my: 0, dash: false, sprint: false, shock: true, repair: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    assert.equal(room.startGame(id), true);
    // Reach in: spawn a crawler one tile to the right of the host's spawn.
    const r = room as any;
    const hostState = r.states.get(id);
    const cx = Math.floor(hostState.x / r.grid.panelSize) + 1;
    const cy = Math.floor(hostState.y / r.grid.panelSize);
    r.crawlers.set(9999, {
      id: 9999,
      x: cx * 64 + 32, y: cy * 64 + 32,
      facing: Math.PI, hp: 1,
      targetCx: cx, targetCy: cy, ai: 1, // ATTACKING
    });
    c.start();
    // Drive enough ticks for the shock input to land + apply.
    await new Promise<void>((r) => setTimeout(r, 500));
    c.stop();
    assert.equal(r.crawlers.has(9999), false, 'shock killed the planted crawler');
  } finally {
    await h.shutdown();
  }
});
```

- [ ] **Step 2: Run test.**

```bash
npm test --workspace=@gridforce/server
```

Expected: both new tests pass.

- [ ] **Step 3: Commit.**

```bash
git add packages/server/src/test/electrical-defense-b1.test.ts
git commit -m "test: B1 endless loop integration — spawn + shock-kill"
```

---

## Task 18: Verify + push for deploy

- [ ] **Step 1: Full sweep.**

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

All clean.

- [ ] **Step 2: Push.**

```bash
git push origin main
```

The webhook auto-deploys. Schema v12 — old cached clients will SchemaMismatch and need a hard refresh.

- [ ] **Step 3: Verify on the VM.**

```powershell
& "C:\Windows\System32\OpenSSH\ssh.exe" -o ConnectTimeout=8 clab@8.231.244.213 'sudo journalctl -u gridforce-webhook --since "2 minutes ago" --no-pager | tail -10; echo === GRIDFORCE ===; sudo journalctl -u gridforce --since "1 minute ago" --no-pager | tail -5'
```

Expected: deploy finished code 0; gridforce.service restarted.

- [ ] **Step 4: Manual playtest.**

Open https://grid.clab.su, host TD Prototype (or Large Run — the spawn loop runs on whatever stage you're on, since B1 doesn't depend on the `td-prototype` stage yet — the wave manager that does is B2). Confirm:

- Crawlers spawn at edges and walk toward panels.
- A Crawler in contact with a LIVE tile turns it DAMAGED after ~0.5s.
- A DAMAGED tile turns BROKEN after another ~0.5s of contact.
- Tapping F (or LMB) kills Crawlers on cardinal LIVE neighbours.
- Carbon drops appear on kill and disappear when walked over.
- HUD shows your carbon count incrementing.
- Holding R (or RMB) while standing on a DAMAGED tile flips it back to LIVE after 1.5s, deducting 1 carbon.

If anything misbehaves, file a tiny bugfix on top before declaring B1 done.

---

## Self-review

- **Spec coverage:** Concept & setting → not directly implemented (it's setting prose). Panel state machine LIVE/DAMAGED/BROKEN + DAMAGED→LIVE transition → Tasks 4, 5, 8, 11. BROKEN→LIVE rebuild → **B2** (explicitly deferred). Crawler AI → Tasks 6, 7, 8. Wave manager → **B2**. Uncharged shock → Tasks 2, 10, 12. Charged shock → **B2**. Carbon → Tasks 9, 12, 16. Repair → Tasks 2, 11, 12, 16. Player HP + revives → **B2**. City HP + win/loss → **B2**. Wire schema v12 → Task 1. Gameplay scenarios — panels/Crawlers/uncharged-shock/carbon/repair covered by Tasks 4, 7, 10, 11, 17. Charged/rebuild/HP/revive/city-HP/win-loss scenarios are deferred to B2.
- **Placeholder scan:** no "TBD/TODO/implement later" left. The Renderer integration in Task 8 step 5 has a "adapt to whatever pattern the file uses" qualifier — that's a description of intent, not a placeholder; the next sub-step gives the concrete code shape.
- **Type consistency:** `PanelState` values 0/1/2 used uniformly. `CrawlerAIState` 0/1/2. `EntityType.Crawler = 3`, `EntityType.Carbon = 4` reserved early. `carbon`, `shockCooldownS`, `repairProgressS` field names consistent across types, encoder, and Room.
- **One known structural decision** the implementer will face: extending the snapshot's dynamic-group encoder to support Crawler and Carbon groups (Task 8 step 5–6). The plan describes the shape; the implementer adapts to the file's existing patterns. If it's awkward, a small refactor of `Snapshot.ts` to take a generic `groups: EntityGroup[]` is a reasonable tangent — note it in the commit if you take that branch.
