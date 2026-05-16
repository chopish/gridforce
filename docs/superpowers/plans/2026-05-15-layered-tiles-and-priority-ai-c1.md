# Layered Tiles & Priority AI — C1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the foundation slab from the layered-tiles spec — multi-layer tile data model (L0/L1/L2), weight-based structural integrity, conduction derived from L1 HP, cursor-aimed shock resolution (both uncharged and charged), panel-jump rework, walk-speed bump (sprint removed), camera (follow + zoom + free pan + edge-pan-option), and a minimap. Behaviour-compatible with B1's visible single-bug gameplay loop.

**Architecture:** Schema bumps to **v13**. The flat `Uint8Array panelStates` is replaced by four parallel byte buffers (`l0Hp`, `l1Hp`, `l2Kind`, `l2Hp`) — one per layer — each RLE-encoded in the snapshot, raw in the welcome. A new pure-shared `integrity.ts` module computes weight-driven damage per tick; the room aggregates bug weights per tile (own tile + 4 cardinal neighbours), then applies damage to whichever layer is currently topmost (L2 if present, else L1, else L0). Crawler `step()` is simplified — its ATTACKING state no longer mutates per-panel attack timers; it just contributes weight to its target tile and transitions to TRANSITING when both L0 and L1 at that tile are gone. Cursor-derived facing rides on `PlayerInput` (`facingRadQ`, u8). The shock input becomes held-state on the wire — uncharged fires on rising edge, charged fires on release after ≥ 0.6 s of hold. Panel-jump moves from "rising-edge in facing direction" to "hold Shift, place cursor with WASD, release to jump" — `PlayerInput` adds `jumpHeld` bit and `jumpCursorDx`/`jumpCursorDy` (i8, ±2 each). Sprint is dropped entirely and default walk speed bumps to `1.4×` the old walk. Camera is a new client-side `CameraController` exposing a `viewMatrix`; the renderer applies it once per frame. The minimap is a separate Pixi container reading the same client-mirrored state.

**Tech Stack:** TypeScript + npm workspaces (`@gridforce/{shared,server,client}`). `node --test` for tests. Vite for the client. Pixi.js for rendering.

**Spec:** `docs/superpowers/specs/2026-05-15-layered-tiles-and-priority-ai-design.md`.

**C1 scope explicitly excludes:**
- Priority-driven AI / Mite class / frustration meter (lands in **C2**).
- Player HP / downed / revive / on-contact damage / attack-windup damage (lands in **C2** and **C3**).
- Rebuild (BROKEN→LIVE), wave manager / `loopPhases`, city HP visible to player, win/loss state, run-end summary (lands in **C3**).
- Spawn telegraphs, wave HUD, additional enemy variants (lands in **C4**).
- L2 addon catalog (reinforcement, bright panel) — only the data model + wire bytes ship in C1, no specific addons.
- Settings UI for edge-pan toggle (the toggle is wired through but hard-coded to `false` in C1; a future settings spec exposes it).
- New tile-rendering art passes beyond the placeholders specified.

---

## Task 1: Schema v13 + C1 tuning constants

Foundation — bump the wire version and define the constants the rest of the plan references.

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Edit `constants.ts`** — bump version, add v13 changelog, add C1 constants, bump player walk speed, remove sprint multiplier.

Update the version constant and history block (append the new line; keep prior history):

```ts
//  v13: Layered tiles + priority-AI foundation. PlayerInput drops `dash`
//       and `sprint`, adds `jumpHeld` + `jumpCursorDx/Dy` (i8 ±2) +
//       `facingRadQ` (u8 cursor-derived facing). Shock becomes held-state.
//       PlayerState adds `facingCursorRad` (cursor-derived, distinct from
//       velocity-derived facing) and `shockHeldS`. Snapshot/Welcome
//       replace the single `panelStates` RLE block with four per-layer
//       byte buffers (l0Hp, l1Hp, l2Kind, l2Hp), RLE-encoded in snapshot
//       and raw in welcome.
export const SCHEMA_VERSION = 13;
```

Bump walk speed and remove sprint:

```ts
// Player movement. Sprint was retired in v13; default walk speed is bumped
// to roughly the previous sprint speed so the larger arena still feels
// traversable. Tactical bursts of speed now come from panel-jump.
export const PLAYER_RADIUS = 12;
export const PLAYER_MOVE_SPEED = 308; // was 220; 220 * 1.4 ≈ 308
```

Delete the `PLAYER_SPRINT_MULTIPLIER` line entirely.

Append a new C1 tuning block (after the existing B1 block):

```ts
// --- C1 layered-tiles & priority-AI tuning (placeholders, expect playtest changes) ---

// Layer HP / armor.
export const L0_DOME_MAX_HP = 200;
export const L1_PANEL_MAX_HP = 100;
export const L2_ADDON_DEFAULT_MAX_HP = 60; // unused until C1's addon catalog ships
export const TILE_LAYER_ARMOR_MAX = 100;

// Weight integrity.
export const WEIGHT_THRESHOLD = 4;
export const BASE_DOT_RATE = 2; // hp/s per unit weight (linear regime)

// Conduction (panel HP fraction at/above which L1 conducts shock).
export const CONDUCTION_THRESHOLD = 0.5;

// Crawler weight contribution (canonical mite-equivalent in C1).
export const CRAWLER_WEIGHT = 1;

// Charged shock.
export const SHOCK_CHARGE_TIME_S = 0.6;
export const SHOCK_CHARGE_COOLDOWN_S = 0.5;

// Camera (defaults; settings UI is a future spec).
export const CAMERA_ZOOM_MIN = 0.5;
export const CAMERA_ZOOM_MAX = 2.0;
export const CAMERA_ZOOM_STEP = 1.1; // per scroll notch
export const CAMERA_FOLLOW_SMOOTH_S = 0.18;
export const CAMERA_EDGE_PAN_DEFAULT = false;
export const CAMERA_EDGE_PAN_BAND_PX = 40;
export const CAMERA_EDGE_PAN_SPEED_PX_S = 600;

// Minimap.
export const MINIMAP_SIZE_PX = 180;
export const MINIMAP_DANGER_WEIGHT_THRESHOLD = 3;

// Panel-jump targeting.
export const PANEL_JUMP_TARGET_RANGE = 2; // per-axis tile cap
```

Also retire `PANEL_ATTACK_TO_DAMAGE_S` and `PANEL_ATTACK_TO_BREAK_S` — they're unused after weight integrity replaces deterministic attack timers. Delete those two `export const` lines.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: compile errors in `crawler.ts` and `Room.ts` referencing the deleted attack-timer constants. **Leave these errors in place** — later tasks fix them by replacing the attack timer with weight integrity.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "schema: bump to v13 for layered tiles, bump walk speed, retire sprint constants"
```

---

## Task 2: `tiles.ts` shared module (TDD)

New shared module — the layered tile data model and its helpers.

**Files:**
- Create: `packages/shared/src/tiles.ts`
- Test: `packages/shared/src/tiles.test.ts`

- [ ] **Step 1: Write failing tests** in `packages/shared/src/tiles.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateTiles,
  conductive,
  damageTopmost,
  indexOf,
  topmostLayer,
  LayerKind,
} from './tiles.js';
import { L0_DOME_MAX_HP, L1_PANEL_MAX_HP } from './constants.js';

test('allocateTiles initializes L0 and L1 at max HP and L2 empty', () => {
  const t = allocateTiles(3, 2);
  assert.equal(t.l0Hp.length, 6);
  assert.equal(t.l1Hp.length, 6);
  assert.equal(t.l2Kind.length, 6);
  assert.equal(t.l2Hp.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(t.l0Hp[i], L0_DOME_MAX_HP);
    assert.equal(t.l1Hp[i], L1_PANEL_MAX_HP);
    assert.equal(t.l2Kind[i], 0);
    assert.equal(t.l2Hp[i], 0);
  }
});

test('indexOf computes row-major offset', () => {
  assert.equal(indexOf(4, 0, 0), 0);
  assert.equal(indexOf(4, 3, 0), 3);
  assert.equal(indexOf(4, 0, 1), 4);
  assert.equal(indexOf(4, 2, 3), 14);
});

test('topmostLayer returns L2 when L2 present, L1 when L1 alive, L0 when only L0 left, null for passage', () => {
  const t = allocateTiles(1, 1);
  assert.equal(topmostLayer(t, 0), LayerKind.L1_PANEL); // default
  t.l2Kind[0] = 1; t.l2Hp[0] = 30;
  assert.equal(topmostLayer(t, 0), LayerKind.L2_ADDON);
  t.l2Hp[0] = 0; // L2 destroyed → falls through to L1
  assert.equal(topmostLayer(t, 0), LayerKind.L1_PANEL);
  t.l1Hp[0] = 0;
  assert.equal(topmostLayer(t, 0), LayerKind.L0_DOME);
  t.l0Hp[0] = 0;
  assert.equal(topmostLayer(t, 0), null);
});

test('conductive returns true above threshold, false below', () => {
  const t = allocateTiles(1, 1);
  assert.equal(conductive(t, 0), true);
  t.l1Hp[0] = Math.ceil(L1_PANEL_MAX_HP * 0.5);
  assert.equal(conductive(t, 0), true);
  t.l1Hp[0] = Math.ceil(L1_PANEL_MAX_HP * 0.5) - 1;
  assert.equal(conductive(t, 0), false);
  t.l1Hp[0] = 0;
  assert.equal(conductive(t, 0), false);
});

test('damageTopmost reduces the topmost layer HP and saturates at 0', () => {
  const t = allocateTiles(1, 1);
  damageTopmost(t, 0, 30);
  assert.equal(t.l1Hp[0], L1_PANEL_MAX_HP - 30);
  damageTopmost(t, 0, 1000); // overkill
  assert.equal(t.l1Hp[0], 0);
  // Now L0 is the topmost.
  damageTopmost(t, 0, 50);
  assert.equal(t.l0Hp[0], L0_DOME_MAX_HP - 50);
  // L2 absorption.
  t.l2Kind[0] = 1; t.l2Hp[0] = 40;
  damageTopmost(t, 0, 30);
  assert.equal(t.l2Hp[0], 10);
  assert.equal(t.l1Hp[0], 0); // untouched by L2 absorption
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm test --workspace=@gridforce/shared`
Expected: module not found / type errors (file doesn't exist).

- [ ] **Step 3: Create the module** at `packages/shared/src/tiles.ts`:

```ts
import {
  CONDUCTION_THRESHOLD,
  L0_DOME_MAX_HP,
  L1_PANEL_MAX_HP,
} from './constants.js';

// Layer enum. Wire-encoded values are stable; use the constants, not the
// raw numbers, anywhere outside the encoder.
export const LayerKind = {
  L0_DOME: 0,
  L1_PANEL: 1,
  L2_ADDON: 2,
} as const;
export type LayerKindValue = (typeof LayerKind)[keyof typeof LayerKind];

// Four parallel byte buffers, each of length cols*rows. Storing per-layer
// (rather than struct-of-arrays per tile) makes RLE encoding per layer
// trivial — a flat-LIVE arena is one or two runs in each buffer.
export interface TileBuffers {
  l0Hp: Uint8Array;
  l1Hp: Uint8Array;
  l2Kind: Uint8Array; // 0 = none; future addon kinds get nonzero
  l2Hp: Uint8Array;
}

export function allocateTiles(cols: number, rows: number): TileBuffers {
  const n = cols * rows;
  const l0Hp = new Uint8Array(n);
  l0Hp.fill(L0_DOME_MAX_HP);
  const l1Hp = new Uint8Array(n);
  l1Hp.fill(L1_PANEL_MAX_HP);
  return {
    l0Hp,
    l1Hp,
    l2Kind: new Uint8Array(n),
    l2Hp: new Uint8Array(n),
  };
}

export function indexOf(cols: number, cx: number, cy: number): number {
  return cy * cols + cx;
}

// Topmost present layer (highest L number) at this tile. Returns null if the
// tile is a passage (L0 destroyed and L1 already gone).
export function topmostLayer(t: TileBuffers, idx: number): LayerKindValue | null {
  if (t.l2Kind[idx]! !== 0 && t.l2Hp[idx]! > 0) return LayerKind.L2_ADDON;
  if (t.l1Hp[idx]! > 0) return LayerKind.L1_PANEL;
  if (t.l0Hp[idx]! > 0) return LayerKind.L0_DOME;
  return null;
}

// Apply damage to the topmost layer. Saturates at 0; excess does not spill
// to lower layers (the next tick will hit the next-topmost layer naturally).
export function damageTopmost(t: TileBuffers, idx: number, amount: number): void {
  if (amount <= 0) return;
  const top = topmostLayer(t, idx);
  if (top === null) return;
  if (top === LayerKind.L2_ADDON) {
    t.l2Hp[idx] = Math.max(0, t.l2Hp[idx]! - amount);
  } else if (top === LayerKind.L1_PANEL) {
    t.l1Hp[idx] = Math.max(0, t.l1Hp[idx]! - amount);
  } else {
    t.l0Hp[idx] = Math.max(0, t.l0Hp[idx]! - amount);
  }
}

// Conductive iff L1 panel HP >= CONDUCTION_THRESHOLD × L1 max.
export function conductive(t: TileBuffers, idx: number): boolean {
  return t.l1Hp[idx]! >= Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD);
}

// True if the tile is fully tunneled (L0 destroyed). Used by Crawler AI to
// transition from ATTACKING → TRANSITING.
export function isPassage(t: TileBuffers, idx: number): boolean {
  return t.l0Hp[idx]! === 0 && t.l1Hp[idx]! === 0;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm test --workspace=@gridforce/shared -- tiles.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/tiles.ts packages/shared/src/tiles.test.ts
git commit -m "shared: add layered tile data model (L0/L1/L2 HP buffers)"
```

---

## Task 3: `integrity.ts` shared module (TDD)

Weight-driven damage formulas. Pure functions, no state.

**Files:**
- Create: `packages/shared/src/integrity.ts`
- Test: `packages/shared/src/integrity.test.ts`

- [ ] **Step 1: Write failing tests** in `packages/shared/src/integrity.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { damagePerSecond } from './integrity.js';
import { BASE_DOT_RATE, WEIGHT_THRESHOLD, TILE_LAYER_ARMOR_MAX } from './constants.js';

test('zero weight = zero damage', () => {
  assert.equal(damagePerSecond(0, 0), 0);
});

test('linear regime below threshold', () => {
  assert.equal(damagePerSecond(1, 0), BASE_DOT_RATE * 1);
  assert.equal(damagePerSecond(2, 0), BASE_DOT_RATE * 2);
  assert.equal(damagePerSecond(WEIGHT_THRESHOLD, 0), BASE_DOT_RATE * WEIGHT_THRESHOLD);
});

test('quadratic regime above threshold', () => {
  // w = threshold + 1 → BASE_DOT_RATE × ((threshold+1) + 1)
  const w = WEIGHT_THRESHOLD + 1;
  assert.equal(damagePerSecond(w, 0), BASE_DOT_RATE * (w + 1));
  // w = threshold + 2 → quadratic kick = 4
  const w2 = WEIGHT_THRESHOLD + 2;
  assert.equal(damagePerSecond(w2, 0), BASE_DOT_RATE * (w2 + 4));
});

test('5 bugs collapse a 100 HP panel ~6× faster than 1 bug', () => {
  const dps1 = damagePerSecond(1, 0);
  const dps5 = damagePerSecond(5, 0);
  // 1 bug: 2 hp/s; 5 bugs: 2*(5 + 1) = 12 hp/s; ratio 6.
  assert.equal(dps5 / dps1, 6);
});

test('armor scales damage to zero at max', () => {
  assert.equal(damagePerSecond(3, TILE_LAYER_ARMOR_MAX), 0);
  // Half armor → half damage.
  const halfArmor = TILE_LAYER_ARMOR_MAX / 2;
  assert.equal(damagePerSecond(3, halfArmor), damagePerSecond(3, 0) / 2);
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm test --workspace=@gridforce/shared`
Expected: module not found.

- [ ] **Step 3: Create the module** at `packages/shared/src/integrity.ts`:

```ts
import {
  BASE_DOT_RATE,
  TILE_LAYER_ARMOR_MAX,
  WEIGHT_THRESHOLD,
} from './constants.js';

// Damage per second to a tile's topmost layer for a given total accumulated
// bug-weight + that layer's armor. Two regimes:
//
//   w ≤ THRESHOLD  →  linear:    BASE × w × (1 - armor/ARMOR_MAX)
//   w >  THRESHOLD  →  quadratic: BASE × (w + (w - THRESHOLD)²) × armorMul
//
// Armor is flat per damage event (the "event" here is one second of DPS).
// A value of 0 = no protection; a value of TILE_LAYER_ARMOR_MAX = invincible.
export function damagePerSecond(totalWeight: number, armor: number): number {
  if (totalWeight <= 0) return 0;
  const armorMul = Math.max(0, 1 - armor / TILE_LAYER_ARMOR_MAX);
  if (armorMul === 0) return 0;
  if (totalWeight <= WEIGHT_THRESHOLD) {
    return BASE_DOT_RATE * totalWeight * armorMul;
  }
  const over = totalWeight - WEIGHT_THRESHOLD;
  return BASE_DOT_RATE * (totalWeight + over * over) * armorMul;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm test --workspace=@gridforce/shared -- integrity.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/integrity.ts packages/shared/src/integrity.test.ts
git commit -m "shared: add weight-integrity damage formula (linear/quadratic regimes)"
```

---

## Task 4: PlayerInput rework — drop dash/sprint, add jumpHeld + jumpCursorDx/Dy + facingRadQ (TDD)

Input wire format and `PlayerInput` type change together. `shock` and `repair` stay as bits (semantics: `shock` is held-state in v13; `repair` already was held).

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/net/messages/Input.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Write failing tests** — append to wire.test.ts:

```ts
test('Input v13 round-trip preserves jumpHeld + cursor offsets + facing + shock-held', () => {
  const inputs = [
    {
      tick: 500, clientTimeMs: 1, mx: 0.1, my: -0.2,
      shock: true, repair: false,
      jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: -2,
      facingRad: Math.PI / 2,
    },
    {
      tick: 501, clientTimeMs: 2, mx: 0, my: 0,
      shock: false, repair: true,
      jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0,
      facingRad: 0,
    },
  ];
  const dec = decodeMessage(InputMsg.encode(inputs));
  const list = dec.payload;
  assert.equal(list.length, 2);
  assert.equal(list[0]!.shock, true);
  assert.equal(list[0]!.repair, false);
  assert.equal(list[0]!.jumpHeld, true);
  assert.equal(list[0]!.jumpCursorDx, 1);
  assert.equal(list[0]!.jumpCursorDy, -2);
  assert.ok(Math.abs(list[0]!.facingRad - Math.PI / 2) < 0.05);
  assert.equal(list[1]!.repair, true);
  assert.equal(list[1]!.jumpHeld, false);
});

test('Input encoder clamps jumpCursor offsets to ±PANEL_JUMP_TARGET_RANGE', () => {
  const inputs = [{
    tick: 1, clientTimeMs: 0, mx: 0, my: 0,
    shock: false, repair: false,
    jumpHeld: true, jumpCursorDx: 99, jumpCursorDy: -99, // wildly out of range
    facingRad: 0,
  }];
  const dec = decodeMessage(InputMsg.encode(inputs));
  const got = dec.payload[0]!;
  assert.equal(got.jumpCursorDx, 2);
  assert.equal(got.jumpCursorDy, -2);
});
```

- [ ] **Step 2: Update `PlayerInput`** in `packages/shared/src/types.ts`:

```ts
export interface PlayerInput {
  tick: number;
  clientTimeMs: number;
  mx: number;
  my: number;
  // Shock is held-state in v13 (server tracks how long the bit has been
  // continuously set to drive the charged-shock charge meter).
  shock: boolean;
  repair: boolean;
  // Panel-jump targeting mode: while jumpHeld, the cursor offset is the
  // player's intended jump target relative to their current tile, capped
  // to ±PANEL_JUMP_TARGET_RANGE per axis. Server applies the jump on the
  // falling edge of jumpHeld (release).
  jumpHeld: boolean;
  jumpCursorDx: number;
  jumpCursorDy: number;
  // Cursor-derived facing in radians, quantized to u8 on the wire. Server
  // re-broadcasts so remote clients can rotate the player sprite to face
  // the aim direction.
  facingRad: number;
}
```

- [ ] **Step 3: Replace the Input wire encoder/decoder** in `packages/shared/src/net/messages/Input.ts`:

```ts
import { INPUT_MSG_MAX_COUNT, PANEL_JUMP_TARGET_RANGE, SCHEMA_VERSION } from '../../constants.js';
import type { PlayerInput } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

const BUTTON_SHOCK     = 1 << 0;
const BUTTON_REPAIR    = 1 << 1;
const BUTTON_JUMP_HELD = 1 << 2;

const TWO_PI = Math.PI * 2;
function quantizeFacing(rad: number): number {
  let f = rad % TWO_PI;
  if (f < 0) f += TWO_PI;
  return Math.round((f / TWO_PI) * 256) & 0xff;
}
function unquantizeFacing(q: number): number {
  return (q / 256) * TWO_PI;
}

function clampOffset(v: number): number {
  if (v > PANEL_JUMP_TARGET_RANGE) return PANEL_JUMP_TARGET_RANGE;
  if (v < -PANEL_JUMP_TARGET_RANGE) return -PANEL_JUMP_TARGET_RANGE;
  return v | 0;
}

// Wire format (v13):
//   u8 count
//   for each input:
//     u32 tick
//     f64 clientTimeMs
//     f32 mx, f32 my
//     u8  buttons          (bit0=shock, bit1=repair, bit2=jumpHeld)
//     i8  jumpCursorDx     (-PANEL_JUMP_TARGET_RANGE..+PANEL_JUMP_TARGET_RANGE)
//     i8  jumpCursorDy     (same)
//     u8  facingRadQ       (quantized 0..255 over 2π)
export function encode(inputs: PlayerInput[]): Uint8Array {
  if (inputs.length === 0 || inputs.length > INPUT_MSG_MAX_COUNT) {
    throw new RangeError(
      `Input count out of range: got ${inputs.length}, expected 1..${INPUT_MSG_MAX_COUNT}`,
    );
  }
  const w = new BinaryWriter(8 + inputs.length * 21);
  writeHeader(w, MessageType.Input, SCHEMA_VERSION);
  w.u8(inputs.length);
  for (const p of inputs) {
    w.u32(p.tick >>> 0);
    w.f64(p.clientTimeMs);
    w.f32(p.mx);
    w.f32(p.my);
    w.u8(
      (p.shock     ? BUTTON_SHOCK     : 0) |
      (p.repair    ? BUTTON_REPAIR    : 0) |
      (p.jumpHeld  ? BUTTON_JUMP_HELD : 0)
    );
    w.i8(clampOffset(p.jumpCursorDx));
    w.i8(clampOffset(p.jumpCursorDy));
    w.u8(quantizeFacing(p.facingRad));
  }
  return w.finish();
}

export function decode(r: BinaryReader): PlayerInput[] {
  const count = r.u8();
  if (count === 0) return [];
  if (count > INPUT_MSG_MAX_COUNT) throw new RangeError(`Input count exceeds cap: ${count}`);
  const out = new Array<PlayerInput>(count);
  for (let i = 0; i < count; i++) {
    const tick = r.u32();
    const clientTimeMs = r.f64();
    const mx = r.f32();
    const my = r.f32();
    const buttons = r.u8();
    const jumpCursorDx = r.i8();
    const jumpCursorDy = r.i8();
    const facingRad = unquantizeFacing(r.u8());
    out[i] = {
      tick,
      clientTimeMs,
      mx,
      my,
      shock:        (buttons & BUTTON_SHOCK)     !== 0,
      repair:       (buttons & BUTTON_REPAIR)    !== 0,
      jumpHeld:     (buttons & BUTTON_JUMP_HELD) !== 0,
      jumpCursorDx,
      jumpCursorDy,
      facingRad,
    };
  }
  return out;
}
```

If `wire.ts` does not already expose `i8` on the BinaryWriter/Reader, add it (matching the existing `u8`/`i32` pattern). One signed byte read/written via `Int8Array`.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm test --workspace=@gridforce/shared`
Expected: round-trip + clamp tests pass. Other tests may now fail in callers that pass the old PlayerInput shape — fix those callers (lobby tests, etc.) by providing the new fields.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "wire: PlayerInput v13 — jumpHeld + cursor offsets + facingRadQ; drop dash/sprint"
```

---

## Task 5: PlayerState + PlayerEncoder rework (TDD)

Add cursor-derived facing + held-shock timer to `PlayerState` and its encoder. Keep the existing velocity-derived `facing` for now if any callers still rely on it; the new field is `facingCursorRad`.

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/net/entities/PlayerEncoder.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Append failing test**:

```ts
test('PlayerEncoder v13 round-trips facingCursorRad and shockHeldS', () => {
  const p: PlayerState = {
    id: 7, x: 100, y: 200,
    facing: 0,
    facingCursorRad: Math.PI,
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name: 'a', ready: false,
    carbon: 5, shockCooldownS: 0, repairProgressS: 0,
    shockHeldS: 0.42,
  };
  const w = new BinaryWriter(64);
  PlayerEncoder.encode(w, p);
  const buf = w.finish();
  const r = new BinaryReader(buf);
  const back = PlayerEncoder.decode(r);
  assert.ok(Math.abs(back.facingCursorRad - Math.PI) < 0.05);
  assert.ok(Math.abs(back.shockHeldS - 0.42) < 0.02);
});
```

- [ ] **Step 2: Update `PlayerState`** in `types.ts`:

```ts
export interface PlayerState {
  id: PlayerId;
  x: number;
  y: number;
  facing: number;             // velocity-derived (legacy; kept for movement animation)
  facingCursorRad: number;    // cursor-derived facing for aim/sprite direction
  panelJumpCooldownS: number;
  stateSeq: number;
  name: string;
  ready: boolean;
  carbon: number;
  shockCooldownS: number;
  repairProgressS: number;
  shockHeldS: number;         // 0..SHOCK_CHARGE_TIME_S (saturates above)
}
```

- [ ] **Step 3: Update PlayerEncoder** — add the two new u8 fields after `repairProgressQ`, before `name`:

```ts
// Append in encode(...):
w.u8(quantizeFacing(p.facingCursorRad));
w.u8(quantizeTimer(p.shockHeldS)); // saturates at 1.0s — SHOCK_CHARGE_TIME_S is 0.6s
// (existing) w.string(p.name);

// In decode(...):
const facingCursorRad = unquantizeFacing(r.u8());
const shockHeldS = unquantizeTimer(r.u8());
// (existing) const name = r.string();

// And add the new fields to the returned object:
return {
  id, x, y,
  facing, facingCursorRad,
  panelJumpCooldownS, stateSeq, name, ready,
  carbon, shockCooldownS, repairProgressS,
  shockHeldS,
};
```

- [ ] **Step 4: Run the test — expect PASS**.

Run: `npm test --workspace=@gridforce/shared`

- [ ] **Step 5: Commit**.

```bash
git add packages/shared/src
git commit -m "wire: PlayerState v13 — facingCursorRad + shockHeldS"
```

---

## Task 6: Snapshot v13 — multi-layer tile RLE (TDD)

Replace the single `panelStates` RLE block with four per-layer byte buffers, each RLE-encoded. Drop the `panelCols`/`panelRows` u16 prefix in favour of relying on `grid.cols × grid.rows` for decode length (it's already on the Welcome). For snapshot decode, the client carries `(cols, rows)` from Welcome.

**Files:**
- Modify: `packages/shared/src/types.ts` (replace `panelStates` field with `tiles: TileBuffers`)
- Modify: `packages/shared/src/net/messages/Snapshot.ts`
- Modify: `packages/shared/src/panels.ts` — keep `encodeRle/decodeRle` (still useful), but mark `PanelState` enum / `allLive` deprecated; the spec retires panel-state language. We can delete the enum once all readers are off it (last call lands in Task 18). For now leave it but no new code should reference it.
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Replace `panelStates` / `panelCols` / `panelRows` on `SnapshotPayload`** with `tiles: TileBuffers`:

```ts
import type { TileBuffers } from './tiles.js';

export interface SnapshotPayload {
  // ... existing fields ...
  tiles: TileBuffers;
  players: PlayerState[];
  npcs: NpcState[];
  crawlers: CrawlerState[];
  carbons: CarbonState[];
}
```

- [ ] **Step 2: Append failing test**:

```ts
test('Snapshot v13 round-trips multi-layer tile state', () => {
  const cols = 4, rows = 3;
  const tiles = {
    l0Hp: new Uint8Array([200,200,200,200, 200,150,150,200, 200,200,200,200]),
    l1Hp: new Uint8Array([100,100,100,100, 100, 50, 0,100, 100,100,100,100]),
    l2Kind: new Uint8Array(12),
    l2Hp: new Uint8Array(12),
  };
  const payload: SnapshotPayload = makeBaselineSnapshot({ tiles });
  const buf = SnapshotMsg.encode(payload);
  const r = new BinaryReader(buf.slice(4)); // skip msg header
  // ... (decode using existing helper) ...
  const dec = SnapshotMsg.decode(r);
  assert.deepEqual(Array.from(dec.tiles.l1Hp), Array.from(tiles.l1Hp));
  assert.deepEqual(Array.from(dec.tiles.l0Hp), Array.from(tiles.l0Hp));
  assert.deepEqual(Array.from(dec.tiles.l2Kind), Array.from(tiles.l2Kind));
  assert.deepEqual(Array.from(dec.tiles.l2Hp), Array.from(tiles.l2Hp));
});
```

(`makeBaselineSnapshot` is a test helper — write a minimal one in the test file that fills the other required SnapshotPayload fields with defaults.)

- [ ] **Step 3: Rewrite the snapshot encoder/decoder** — replace the panel-state block with four RLE blocks. The encoder needs the buffer length to write before the RLE so decode knows how many cells:

```ts
import { encodeRle, decodeRle } from '../../panels.js'; // still re-used
// ... in encode():
// (remove: w.u16(p.panelCols); w.u16(p.panelRows); encodeRle(w, p.panelStates);)
w.u16(p.tiles.l0Hp.length); // cols*rows, used by decoder
encodeRle(w, p.tiles.l0Hp);
encodeRle(w, p.tiles.l1Hp);
encodeRle(w, p.tiles.l2Kind);
encodeRle(w, p.tiles.l2Hp);

// ... in decode():
const tilesLen = r.u16();
const tiles = {
  l0Hp: decodeRle(r, tilesLen),
  l1Hp: decodeRle(r, tilesLen),
  l2Kind: decodeRle(r, tilesLen),
  l2Hp: decodeRle(r, tilesLen),
};
// (remove the panelCols/panelRows/panelStates lines from the returned object)
```

- [ ] **Step 4: Run the test — expect PASS.** Other tests that referenced `panelStates`/`panelCols` will fail — update them to use the new shape.

- [ ] **Step 5: Commit**.

```bash
git add packages/shared/src
git commit -m "wire: Snapshot v13 — replace panelStates RLE with four per-layer RLE blocks"
```

---

## Task 7: Welcome v13 — multi-layer tile raw (TDD)

Same shape as Task 6 but raw bytes (no RLE) for joiner-friendly decode.

**Files:**
- Modify: `packages/shared/src/types.ts` (replace `panelStates: Uint8Array` on `WelcomePayload` with `tiles: TileBuffers`)
- Modify: `packages/shared/src/net/messages/Welcome.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Replace field on `WelcomePayload`**:

```ts
export interface WelcomePayload {
  // ... existing fields ...
  tiles: TileBuffers;
}
```

- [ ] **Step 2: Append failing test** mirroring Task 6 but for `WelcomeMsg`.

- [ ] **Step 3: Rewrite the welcome encoder/decoder**:

```ts
// ... in encode():
const n = p.tiles.l0Hp.length;
w.varuint(n);
for (let i = 0; i < n; i++) w.u8(p.tiles.l0Hp[i]!);
for (let i = 0; i < n; i++) w.u8(p.tiles.l1Hp[i]!);
for (let i = 0; i < n; i++) w.u8(p.tiles.l2Kind[i]!);
for (let i = 0; i < n; i++) w.u8(p.tiles.l2Hp[i]!);

// ... in decode():
const n = r.varuint();
const tiles = {
  l0Hp: new Uint8Array(n),
  l1Hp: new Uint8Array(n),
  l2Kind: new Uint8Array(n),
  l2Hp: new Uint8Array(n),
};
for (let i = 0; i < n; i++) tiles.l0Hp[i] = r.u8();
for (let i = 0; i < n; i++) tiles.l1Hp[i] = r.u8();
for (let i = 0; i < n; i++) tiles.l2Kind[i] = r.u8();
for (let i = 0; i < n; i++) tiles.l2Hp[i] = r.u8();
```

- [ ] **Step 4: Run the test — expect PASS.**

- [ ] **Step 5: Commit**.

```bash
git add packages/shared/src
git commit -m "wire: Welcome v13 — replace panelStates raw with four per-layer raw blocks"
```

---

## Task 8: Crawler step rewrite — retire attack timer, use weight model (TDD)

Crawler `step()` simplifies: APPROACHING walks toward target (unchanged), ATTACKING just sits (Room aggregates weight separately), TRANSITING walks through and exits.

**Files:**
- Modify: `packages/shared/src/enemies/crawler.ts`
- Test: `packages/shared/src/enemies/crawler.test.ts`

- [ ] **Step 1: Replace existing crawler tests** with the new contract:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateTiles, indexOf } from '../tiles.js';
import { stepCrawler, type CrawlerStepContext } from './crawler.js';
import { CrawlerAIState, type CrawlerState } from '../types.js';

const GRID = { cols: 18, rows: 12, panelSize: 64 };

function makeCtx(): CrawlerStepContext {
  return { tiles: allocateTiles(GRID.cols, GRID.rows) };
}

test('APPROACHING moves toward target until within half a panel', () => {
  const c: CrawlerState = {
    id: 1, x: 0, y: 32, facing: 0, hp: 1,
    targetCx: 5, targetCy: 0, ai: CrawlerAIState.APPROACHING,
  };
  const ctx = makeCtx();
  const after = stepCrawler(c, 0.1, GRID, ctx);
  assert.ok(after.x > 0);
  assert.equal(after.ai, CrawlerAIState.APPROACHING);
});

test('ATTACKING transitions to TRANSITING when its tile is a passage', () => {
  const c: CrawlerState = {
    id: 1, x: 0, y: 0, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.ATTACKING,
  };
  const ctx = makeCtx();
  const idx = indexOf(GRID.cols, 0, 0);
  ctx.tiles.l1Hp[idx] = 0;
  ctx.tiles.l0Hp[idx] = 0;
  const after = stepCrawler(c, 0.1, GRID, ctx);
  assert.equal(after.ai, CrawlerAIState.TRANSITING);
});

test('TRANSITING walks past the world edge and gets hp=0', () => {
  const c: CrawlerState = {
    id: 1, x: 5, y: 32, facing: Math.PI, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.TRANSITING,
  };
  const ctx = makeCtx();
  const after = stepCrawler(c, 1.0, GRID, ctx);
  assert.equal(after.hp, 0);
  assert.ok(after.x < 0);
});

test('ATTACKING crawler does not mutate tile HP directly (weight handled by Room)', () => {
  const c: CrawlerState = {
    id: 1, x: 0, y: 0, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.ATTACKING,
  };
  const ctx = makeCtx();
  const idx = indexOf(GRID.cols, 0, 0);
  const beforeHp = ctx.tiles.l1Hp[idx];
  stepCrawler(c, 1.0, GRID, ctx);
  assert.equal(ctx.tiles.l1Hp[idx], beforeHp);
});
```

- [ ] **Step 2: Rewrite `crawler.ts`**:

```ts
import { CRAWLER_MOVE_SPEED } from '../constants.js';
import { indexOf, isPassage, type TileBuffers } from '../tiles.js';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';

export interface CrawlerStepContext {
  tiles: TileBuffers;
}

const HALF_PANEL_FACTOR = 0.5;

export function stepCrawler(
  c: CrawlerState,
  dt: number,
  grid: GridDef,
  ctx: CrawlerStepContext,
): CrawlerState {
  switch (c.ai) {
    case CrawlerAIState.APPROACHING: return stepApproaching(c, dt, grid);
    case CrawlerAIState.ATTACKING:   return stepAttacking(c, grid, ctx);
    case CrawlerAIState.TRANSITING:  return stepTransiting(c, dt, grid);
    default: return c;
  }
}

function stepApproaching(c: CrawlerState, dt: number, grid: GridDef): CrawlerState {
  const tx = c.targetCx * grid.panelSize + grid.panelSize / 2;
  const ty = c.targetCy * grid.panelSize + grid.panelSize / 2;
  const dx = tx - c.x;
  const dy = ty - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= grid.panelSize * HALF_PANEL_FACTOR) {
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

function stepAttacking(c: CrawlerState, grid: GridDef, ctx: CrawlerStepContext): CrawlerState {
  const idx = indexOf(grid.cols, c.targetCx, c.targetCy);
  if (isPassage(ctx.tiles, idx)) {
    return { ...c, ai: CrawlerAIState.TRANSITING };
  }
  // Crawler contributes weight to its target tile; damage is applied by the
  // Room's weight-integrity loop, not here.
  return c;
}

function stepTransiting(c: CrawlerState, dt: number, grid: GridDef): CrawlerState {
  const step = CRAWLER_MOVE_SPEED * dt;
  const nx = c.x + Math.cos(c.facing) * step;
  const ny = c.y + Math.sin(c.facing) * step;
  const worldW = grid.cols * grid.panelSize;
  const worldH = grid.rows * grid.panelSize;
  if (nx < 0 || nx > worldW || ny < 0 || ny > worldH) {
    return { ...c, x: nx, y: ny, hp: 0 };
  }
  return { ...c, x: nx, y: ny };
}
```

- [ ] **Step 3: Run the test — expect PASS.**

- [ ] **Step 4: Commit**.

```bash
git add packages/shared/src/enemies/crawler.ts packages/shared/src/enemies/crawler.test.ts
git commit -m "crawler: retire attack timer; ATTACKING contributes weight (Room aggregates)"
```

---

## Task 9: Room — replace `panelStates` with `tiles: TileBuffers`

Foundation server-side change: swap the array, fix all readers.

**Files:**
- Modify: `packages/server/src/Room.ts`

- [ ] **Step 1: Find every reference** to `this.panelStates`, `panelCols`, `panelRows`, `PanelState`, `allLive`, `attackTimers` — note locations.

Run: `grep -n -E 'panelStates|panelCols|panelRows|PanelState|allLive|attackTimers' packages/server/src/Room.ts`

- [ ] **Step 2: Replace the panel-state field** with the layered buffers:

```ts
// In the Room class field declarations, replace:
//   private panelStates: Uint8Array;
// with:
import { allocateTiles, type TileBuffers } from '@gridforce/shared';
// ...
private tiles: TileBuffers = allocateTiles(GRID_COLS, GRID_ROWS);
private readonly attackTimers = new Map<number, number>(); // RETIRED in C1, see Task 10
```

In `startGame()` reset state, replace `this.panelStates = allLive(...)` with `this.tiles = allocateTiles(this.grid.cols, this.grid.rows)`. Delete the `attackTimers.clear()` call (it's about to be retired completely).

- [ ] **Step 3: Update `broadcastSnapshot`** — replace the panel-state field in the SnapshotPayload object with `tiles: this.tiles`. Drop `panelStates` / `panelCols` / `panelRows` from the constructed payload.

- [ ] **Step 4: Update `sendWelcome`** — replace `panelStates: this.panelStates` with `tiles: this.tiles`.

- [ ] **Step 5: Update shock + repair** — anywhere shock or repair reads `panelStates[idx] === PanelState.LIVE` etc., replace with the new helpers:

```ts
import { conductive, topmostLayer, LayerKind } from '@gridforce/shared';
// LIVE-conductive check:
if (!conductive(this.tiles, idx)) continue;
// Damaging-the-panel check (repair) — repair target valid iff topmost is L1 with HP < max:
const top = topmostLayer(this.tiles, idx);
if (top !== LayerKind.L1_PANEL) continue;
```

The full mechanic rewrites land in Tasks 11-13; this step only makes the existing call sites compile against the new field names. Inline `// TODO: rewritten in Task 11/12/13` comments where the logic still needs to change.

- [ ] **Step 6: Typecheck + test**

Run: `npm run typecheck && npm test --workspace=@gridforce/server`
Expected: some server tests fail (they assert old panel-state behaviour). Leave the failures in place — Task 10 fixes the integrity loop, then individual tests get rewritten in subsequent tasks.

- [ ] **Step 7: Commit**.

```bash
git add packages/server/src/Room.ts
git commit -m "room: replace panelStates with TileBuffers (compat shim; integrity rewrite in Task 10)"
```

---

## Task 10: Room — weight aggregation + integrity damage loop

Replace the deterministic per-panel attack timer with the weight-driven damage model from `integrity.ts`.

**Files:**
- Modify: `packages/server/src/Room.ts`

- [ ] **Step 1: Delete `attackTimers`** field and any remaining calls to `attackTimers.set` / `.get` / `.clear`. Remove the import of `attackTimers` from any helper module.

- [ ] **Step 2: Add a weight aggregation pass** in `physicsStep`, immediately after the crawler step loop. Sketch:

```ts
import { damagePerSecond } from '@gridforce/shared';
import { CRAWLER_WEIGHT } from '@gridforce/shared'; // or directly from constants.js

private applyWeightIntegrity(dt: number): void {
  const cols = this.grid.cols;
  const rows = this.grid.rows;
  const n = cols * rows;
  // Per-tile bug weight (only ATTACKING crawlers contribute — APPROACHING
  // bugs don't yet, and TRANSITING bugs are leaving).
  const weightAt = new Uint16Array(n);
  for (const c of this.crawlers.values()) {
    if (c.ai !== CrawlerAIState.ATTACKING) continue;
    weightAt[indexOf(cols, c.targetCx, c.targetCy)] += CRAWLER_WEIGHT;
  }
  // For each tile, total contributing weight = own + 4 cardinal neighbors.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const idx = indexOf(cols, x, y);
      let w = weightAt[idx]!;
      if (x > 0)         w += weightAt[indexOf(cols, x - 1, y)]!;
      if (x < cols - 1)  w += weightAt[indexOf(cols, x + 1, y)]!;
      if (y > 0)         w += weightAt[indexOf(cols, x, y - 1)]!;
      if (y < rows - 1)  w += weightAt[indexOf(cols, x, y + 1)]!;
      if (w === 0) continue;
      const top = topmostLayer(this.tiles, idx);
      if (top === null) continue;
      // Armor: 0 for L1 panel, 0 for L0 dome in C1 (L2 addons will set armor
      // when their catalog ships).
      const armor = 0;
      const dps = damagePerSecond(w, armor);
      damageTopmost(this.tiles, idx, dps * dt);
    }
  }
}
```

Wire it into `physicsStep` after the crawler step loop and before broadcasting the snapshot:

```ts
for (const c of this.crawlers.values()) {
  const next = stepCrawler(c, dt, this.grid, { tiles: this.tiles });
  this.crawlers.set(c.id, next);
}
this.applyWeightIntegrity(dt);
// (existing) reap dead crawlers
```

- [ ] **Step 3: Add a single integration test** at `packages/server/src/test/integrity.test.ts`:

```ts
test('one crawler attacks an edge panel → L1 HP decreases over time', async () => {
  const room = makeRoomWithCrawlerAttacking(0, 0); // helper plants crawler in ATTACKING at tile (0,0)
  const idx = indexOf(room.grid.cols, 0, 0);
  const before = room.tiles.l1Hp[idx]!;
  await tickFor(room, 1.0); // 1 second
  const after = room.tiles.l1Hp[idx]!;
  assert.ok(after < before);
  assert.ok(after >= before - 4); // 1 bug × 2 dps × 1s = 2 hp; allow ±2 for rounding
});

test('five crawlers attack one panel → quadratic regime', async () => {
  const room = makeRoomWithCrawlersAttacking([[0,0],[0,0],[0,0],[0,0],[0,0]]);
  const idx = indexOf(room.grid.cols, 0, 0);
  const before = room.tiles.l1Hp[idx]!;
  await tickFor(room, 1.0);
  const after = room.tiles.l1Hp[idx]!;
  // 5 bugs on one tile: dps = 2 × (5 + 1) = 12. After 1s: ~12 hp gone.
  // Allow ±2 for rounding / discrete tick granularity.
  assert.ok(before - after >= 10);
  assert.ok(before - after <= 14);
});
```

(`makeRoomWithCrawlerAttacking` and `tickFor` are small test helpers — write them in the test file or a `test/_helpers.ts`. The existing `electrical-defense-b1.test.ts` has similar helpers to model after.)

- [ ] **Step 4: Run the tests — expect PASS.**

- [ ] **Step 5: Commit**.

```bash
git add packages/server/src packages/shared/src
git commit -m "room: replace attack timers with weight-driven integrity damage loop"
```

---

## Task 11: Room — cursor-aim uncharged shock

Refactor uncharged shock from "all 4 LIVE cardinals" to "the one cardinal closest to cursor, if conductive."

**Files:**
- Modify: `packages/server/src/Room.ts`
- Test: `packages/server/src/test/shock.test.ts` (already exists from B1; rewrite for C1 semantics)

- [ ] **Step 1: Rewrite `shock.test.ts`** for the new contract:

```ts
test('uncharged shock fires on cursor-snapped cardinal only', () => {
  // Player at center of (5,5) facing east; crawler on (6,5) and another on (4,5).
  // Tap shock: only the (6,5) crawler dies (the eastward cardinal).
  const room = makeRoomWithCrawlers([[6,5],[4,5]]);
  setPlayerAt(room, 5, 5);
  inputPlayer(room, { shock: true, facingRad: 0 /* east */ });
  tick(room);
  assertCrawlerDead(room, 6, 5);
  assertCrawlerAlive(room, 4, 5);
});

test('uncharged shock at cursor pointing west hits west tile only', () => {
  const room = makeRoomWithCrawlers([[6,5],[4,5]]);
  setPlayerAt(room, 5, 5);
  inputPlayer(room, { shock: true, facingRad: Math.PI });
  tick(room);
  assertCrawlerDead(room, 4, 5);
  assertCrawlerAlive(room, 6, 5);
});

test('uncharged shock on DAMAGED tile does not conduct', () => {
  const room = makeRoomWithCrawlers([[6,5]]);
  setPlayerAt(room, 5, 5);
  // Damage L1 below conduction threshold.
  const idx = indexOf(room.grid.cols, 6, 5);
  room.tiles.l1Hp[idx] = Math.floor(L1_PANEL_MAX_HP * 0.4);
  inputPlayer(room, { shock: true, facingRad: 0 });
  tick(room);
  assertCrawlerAlive(room, 6, 5);
});

test('uncharged shock honours cooldown', () => {
  const room = makeRoomWithCrawlers([[6,5]]);
  setPlayerAt(room, 5, 5);
  inputPlayer(room, { shock: true, facingRad: 0 });
  tick(room);
  // Kill consumed. Second tap within cooldown: no respawn anyway, but
  // ensure cooldown timer is set on PlayerState.
  const pl = playerState(room);
  assert.ok(pl.shockCooldownS > 0);
});
```

- [ ] **Step 2: Update `Room.applyShock`** — read `facingRad` from the player's most recent input; snap to cardinal; pick the one cardinal tile; conduct + kill:

```ts
private applyShock(playerId: PlayerId, p: PlayerState, input: PlayerInput): void {
  if (p.shockCooldownS > 0) return;
  const cardinal = snapToCardinal(input.facingRad); // 0=N, 1=E, 2=S, 3=W
  const px = Math.floor(p.x / this.grid.panelSize);
  const py = Math.floor(p.y / this.grid.panelSize);
  const dx = cardinal === 1 ? 1 : cardinal === 3 ? -1 : 0;
  const dy = cardinal === 0 ? -1 : cardinal === 2 ? 1 : 0;
  const tx = px + dx, ty = py + dy;
  if (tx < 0 || tx >= this.grid.cols || ty < 0 || ty >= this.grid.rows) return;
  const idx = indexOf(this.grid.cols, tx, ty);
  if (!conductive(this.tiles, idx)) return;
  // Kill any crawlers whose center is in this tile.
  for (const c of this.crawlers.values()) {
    const ccx = Math.floor(c.x / this.grid.panelSize);
    const ccy = Math.floor(c.y / this.grid.panelSize);
    if (ccx === tx && ccy === ty) {
      this.killCrawler(c.id);
    }
  }
  p.shockCooldownS = SHOCK_COOLDOWN_S;
}

function snapToCardinal(rad: number): 0 | 1 | 2 | 3 {
  // 0=N (up), 1=E, 2=S (down), 3=W. Angle 0 = east in standard math, but our
  // y is screen-down, so east is rad=0 and south is rad=π/2.
  let f = rad % (Math.PI * 2);
  if (f < 0) f += Math.PI * 2;
  // Sectors: [-π/4..π/4]=E, [π/4..3π/4]=S, [3π/4..5π/4]=W, [5π/4..7π/4]=N
  const s = Math.PI / 4;
  if (f < s || f >= 7 * s) return 1;       // E
  if (f < 3 * s) return 2;                  // S
  if (f < 5 * s) return 3;                  // W
  return 0;                                 // N
}
```

The shock rising-edge detection (since v13 makes the bit held-state) lives in the per-player input handler: track `prevShockHeld` per player; fire on `!prevShockHeld && currentShockHeld`. The "held release" path lands in Task 12 (charged shock).

- [ ] **Step 3: Run the tests — expect PASS.**

- [ ] **Step 4: Commit**.

```bash
git add packages/server/src
git commit -m "shock: rewrite uncharged shock as cursor-snapped single-cardinal pulse"
```

---

## Task 12: Room — charged shock (held → release)

Track `shockHeldS` per player; on release, if it crossed `SHOCK_CHARGE_TIME_S`, fire a charged pulse (2-tile line, conduction-gated); otherwise fire uncharged.

**Files:**
- Modify: `packages/server/src/Room.ts`
- Test: `packages/server/src/test/shock-charged.test.ts` (new)

- [ ] **Step 1: Write the failing tests**:

```ts
test('held shock builds shockHeldS and clamps at SHOCK_CHARGE_TIME_S', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  inputPlayerHolding(room, { shock: true, facingRad: 0 });
  tickFor(room, 0.3);
  assert.ok(playerState(room).shockHeldS >= 0.28 && playerState(room).shockHeldS <= 0.32);
  tickFor(room, 1.0); // overhold
  assert.ok(playerState(room).shockHeldS <= SHOCK_CHARGE_TIME_S + 0.05);
});

test('release after full charge fires 2-tile cardinal line with conduction gate', () => {
  // Player at (5,5); crawlers at (6,5) and (7,5). All tiles LIVE.
  const room = makeRoomWithCrawlers([[6,5],[7,5]]);
  setPlayerAt(room, 5, 5);
  inputPlayerHolding(room, { shock: true, facingRad: 0 });
  tickFor(room, SHOCK_CHARGE_TIME_S + 0.05);
  inputPlayer(room, { shock: false, facingRad: 0 }); // release
  tick(room);
  assertCrawlerDead(room, 6, 5);
  assertCrawlerDead(room, 7, 5);
});

test('charged shock stops at non-conductive tile 1', () => {
  const room = makeRoomWithCrawlers([[6,5],[7,5]]);
  setPlayerAt(room, 5, 5);
  // Make tile (6,5) DAMAGED below threshold.
  const idx1 = indexOf(room.grid.cols, 6, 5);
  room.tiles.l1Hp[idx1] = Math.floor(L1_PANEL_MAX_HP * 0.4);
  inputPlayerHolding(room, { shock: true, facingRad: 0 });
  tickFor(room, SHOCK_CHARGE_TIME_S + 0.05);
  inputPlayer(room, { shock: false, facingRad: 0 });
  tick(room);
  // Both crawlers survive: tile 1 doesn't conduct, so the pulse never reaches tile 2.
  // (Tile 1 itself still gets the pulse, but it has no kill-tile semantics for the
  //  crawler on it; conduction is the question — actually wait, the spec says
  //  "Tile 2 only conducts if tile 1 was LIVE-conductive." Tile 1 still receives
  //  the pulse. So the crawler on tile 1 dies, the one on tile 2 lives.)
  assertCrawlerDead(room, 6, 5); // wait — re-read spec
  // Actually: uncharged shock kills a crawler on a NON-conductive tile? No — the
  // spec says the pulse only hits if the tile is LIVE-conductive. Reread.
  // ...
});
```

**Note for the implementer:** The charged-shock test above hits an ambiguity. Re-read the spec carefully:

> "On release at full charge: snap aim to nearest cardinal. The pulse hits tile 1 (one step out) and tile 2 (two steps out) along that line. Tile 2 receives the pulse only if tile 1 was LIVE-conductive"

So **tile 1 only receives the pulse if tile 1 is itself LIVE-conductive** — same rule as uncharged. The crawler on a non-conductive tile 1 lives. Update the test accordingly: both crawlers survive when tile 1 is below conduction threshold.

- [ ] **Step 2: Implement charged shock in `Room`**:

```ts
// Per-player state: track previous shock bit + current held duration.
// Stored on PlayerState as shockHeldS (already added in Task 5).

// Each player tick:
const prevHeld = pl.shockHeldS > 0; // shockHeldS > 0 implies still holding
if (input.shock) {
  pl.shockHeldS = Math.min(SHOCK_CHARGE_TIME_S, pl.shockHeldS + dt);
  if (!prevHeld) {
    // Rising edge — fire uncharged immediately (matches old B1 feel).
    this.applyShock(playerId, pl, input);
  }
} else if (prevHeld) {
  // Falling edge — if fully charged, fire charged; else (no-op: the rising-edge
  // shot already happened).
  if (pl.shockHeldS >= SHOCK_CHARGE_TIME_S) {
    this.applyChargedShock(playerId, pl, input);
  }
  pl.shockHeldS = 0;
}
```

`applyChargedShock` mirrors `applyShock` but walks 2 tiles along the cardinal:

```ts
private applyChargedShock(playerId: PlayerId, p: PlayerState, input: PlayerInput): void {
  const cardinal = snapToCardinal(input.facingRad);
  const px = Math.floor(p.x / this.grid.panelSize);
  const py = Math.floor(p.y / this.grid.panelSize);
  const dx = cardinal === 1 ? 1 : cardinal === 3 ? -1 : 0;
  const dy = cardinal === 0 ? -1 : cardinal === 2 ? 1 : 0;
  // Tile 1.
  const t1x = px + dx, t1y = py + dy;
  if (t1x < 0 || t1x >= this.grid.cols || t1y < 0 || t1y >= this.grid.rows) return;
  const idx1 = indexOf(this.grid.cols, t1x, t1y);
  if (!conductive(this.tiles, idx1)) {
    // Hit-tile-1 attempt fails — no kill, but still apply cooldown.
    p.shockCooldownS = SHOCK_CHARGE_COOLDOWN_S;
    return;
  }
  this.killCrawlersOn(t1x, t1y);
  // Tile 2 — only if tile 1 was conductive (which it was, by the early-return above).
  const t2x = px + dx * 2, t2y = py + dy * 2;
  if (t2x >= 0 && t2x < this.grid.cols && t2y >= 0 && t2y < this.grid.rows) {
    const idx2 = indexOf(this.grid.cols, t2x, t2y);
    if (conductive(this.tiles, idx2)) {
      this.killCrawlersOn(t2x, t2y);
    }
  }
  p.shockCooldownS = SHOCK_CHARGE_COOLDOWN_S;
}
```

- [ ] **Step 3: Run the tests — expect PASS.**

- [ ] **Step 4: Commit**.

```bash
git add packages/server/src
git commit -m "shock: implement charged shock (held → 2-tile cardinal line, conduction-gated)"
```

---

## Task 13: Room — panel-jump rework (jumpHeld + cursor offsets)

Replace the existing rising-edge "dash" panel-jump with the new hold-Shift + cursor + release mechanic.

**Files:**
- Modify: `packages/server/src/Room.ts`
- Test: `packages/server/src/test/panel-jump.test.ts` (new)

- [ ] **Step 1: Write failing tests**:

```ts
test('release of jumpHeld with cursor (1, 0) teleports the player one tile east', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  // Hold for one tick with cursor offset (1, 0).
  inputPlayer(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  // Release.
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0 });
  tick(room);
  const pl = playerState(room);
  // Player should now be at tile (6, 5) center.
  assert.ok(Math.abs(pl.x - (6 * PANEL_SIZE + PANEL_SIZE / 2)) < 1);
  assert.ok(Math.abs(pl.y - (5 * PANEL_SIZE + PANEL_SIZE / 2)) < 1);
});

test('jump onto an L-1 passage is rejected', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  const targetIdx = indexOf(room.grid.cols, 6, 5);
  room.tiles.l0Hp[targetIdx] = 0;
  room.tiles.l1Hp[targetIdx] = 0;
  inputPlayer(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0 });
  tick(room);
  const pl = playerState(room);
  // Player did NOT move (no floor).
  assert.ok(Math.abs(pl.x - (5 * PANEL_SIZE + PANEL_SIZE / 2)) < 1);
});

test('panel-jump cooldown blocks a second jump within 0.4s', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  // First jump.
  inputPlayer(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0 });
  tick(room);
  // Immediate second jump attempt — should be blocked.
  inputPlayer(room, { jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: 0 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0 });
  tick(room);
  const pl = playerState(room);
  // Should still be at (6,5), not (7,5).
  assert.ok(Math.abs(pl.x - (6 * PANEL_SIZE + PANEL_SIZE / 2)) < 1);
});
```

- [ ] **Step 2: Implement in Room** — replace the existing dash-bit panel-jump logic:

```ts
// Per-player state: track prevJumpHeld.
// On falling edge of jumpHeld, if cooldown is 0, teleport.
const prevHeld = pl._prevJumpHeld ?? false;
pl._prevJumpHeld = input.jumpHeld;
if (prevHeld && !input.jumpHeld && pl.panelJumpCooldownS <= 0) {
  // Use the LAST received input's cursor offsets — captured at the time of release.
  const dx = clamp(input.jumpCursorDx, -PANEL_JUMP_TARGET_RANGE, PANEL_JUMP_TARGET_RANGE);
  const dy = clamp(input.jumpCursorDy, -PANEL_JUMP_TARGET_RANGE, PANEL_JUMP_TARGET_RANGE);
  if (dx === 0 && dy === 0) {
    // Targeting cursor never left center — treat as a cancel.
  } else {
    const px = Math.floor(pl.x / this.grid.panelSize);
    const py = Math.floor(pl.y / this.grid.panelSize);
    const tx = px + dx, ty = py + dy;
    if (tx >= 0 && tx < this.grid.cols && ty >= 0 && ty < this.grid.rows) {
      const idx = indexOf(this.grid.cols, tx, ty);
      // Block jump onto a passage (no floor).
      if (!isPassage(this.tiles, idx)) {
        pl.x = tx * this.grid.panelSize + this.grid.panelSize / 2;
        pl.y = ty * this.grid.panelSize + this.grid.panelSize / 2;
        pl.panelJumpCooldownS = PANEL_JUMP_COOLDOWN_S;
      }
    }
  }
}
```

`_prevJumpHeld` is a server-only transient — keep it on a per-room `Map<PlayerId, ConnectionInputState>` rather than on the wire-encoded `PlayerState`. Don't pollute the wire shape with it.

- [ ] **Step 3: Run the tests — expect PASS.**

- [ ] **Step 4: Commit**.

```bash
git add packages/server/src
git commit -m "panel-jump: rework as hold-Shift cursor-pick + release-to-jump"
```

---

## Task 14: Room — walk speed bump + sprint code removal

Sprint is dropped entirely in v13. Default walk speed is the new `PLAYER_MOVE_SPEED = 308`. The `sprint` field is gone from `PlayerInput` so the room can't read it anyway.

**Files:**
- Modify: `packages/server/src/sim.ts` (or wherever `stepPlayer` lives)

- [ ] **Step 1: Find sprint references**:

Run: `grep -rn 'sprint\|PLAYER_SPRINT_MULTIPLIER' packages/server/src`

- [ ] **Step 2: Delete the sprint code path** — remove the `if (input.sprint) ... × PLAYER_SPRINT_MULTIPLIER` branch from `stepPlayer`. Movement is just `PLAYER_MOVE_SPEED × dt` in the input direction.

- [ ] **Step 3: Verify in tests** — any test asserting sprint behaviour was probably already broken by the type change in Task 4. Delete or rewrite those test cases. Add a smoke test if helpful:

```ts
test('player walks at PLAYER_MOVE_SPEED — no sprint multiplier in v13', async () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  const startX = playerState(room).x;
  inputPlayer(room, { mx: 1, my: 0 });
  await tickFor(room, 1.0);
  const endX = playerState(room).x;
  // Distance ≈ PLAYER_MOVE_SPEED (308) px in 1s, allowing ±10px for tick granularity.
  assert.ok(Math.abs(endX - startX - 308) < 15);
});
```

- [ ] **Step 4: Run the tests — expect PASS.**

- [ ] **Step 5: Commit**.

```bash
git add packages/server/src
git commit -m "movement: drop sprint code path; walk speed is the new baseline"
```

---

## Task 15: PredictedWorld — mirror multi-layer tile state + cursor facing

**Files:**
- Modify: `packages/client/src/sim/PredictedWorld.ts`

- [ ] **Step 1: Replace `panelStates` mirroring** with `tiles` mirroring:

```ts
// In the PredictedWorld class:
tiles: TileBuffers = allocateTiles(GRID_COLS, GRID_ROWS);

// In applyWelcome(welcome):
this.tiles = welcome.tiles; // reference-equality short-circuit downstream is fine

// In applySnapshot(snap):
this.tiles = snap.tiles;
```

Drop the `panelStates`, `panelCols`, `panelRows` fields and any helpers using them.

- [ ] **Step 2: Cursor-facing on PlayerState mirror** — already lands automatically because `PlayerEncoder` is decoding `facingCursorRad`. Confirm the client `PlayerState` interface accepts it (it does, since types.ts is shared).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 4: Commit**.

```bash
git add packages/client/src
git commit -m "client: PredictedWorld mirrors layered tile state"
```

---

## Task 16: InputCapture — cursor facing + jump-modal + held shock + drop sprint

**Files:**
- Modify: `packages/client/src/input/InputCapture.ts`

- [ ] **Step 1: Find current capture fields** — note the existing structure (keyboard listeners, mouse buttons, gamepad polling) before editing.

- [ ] **Step 2: Drop sprint capture entirely.** Remove the `Shift` keydown/keyup → `sprint = true/false` handlers. The Shift key now belongs to panel-jump targeting.

- [ ] **Step 3: Add cursor-facing capture.** Track mouse `(clientX, clientY)`; in `sample()` convert to world coordinates (using the renderer's camera viewMatrix — exposed via a `getCursorWorldPos()` callback the renderer wires in), then to `facingRad` relative to the player's current predicted position:

```ts
private facingRad = 0;

setCursorWorldPosCallback(fn: () => { x: number; y: number }) {
  this.getCursorWorldPos = fn;
}

private updateFacingFromCursor(localPlayerPos: { x: number; y: number }): void {
  if (!this.getCursorWorldPos) return;
  const c = this.getCursorWorldPos();
  this.facingRad = Math.atan2(c.y - localPlayerPos.y, c.x - localPlayerPos.x);
}
```

`sample(localPlayerPos)` is called once per tick — pass the local predicted player position in.

- [ ] **Step 4: Add jump-targeting modal.**

```ts
private jumpHeld = false;
private jumpCursorDx = 0;
private jumpCursorDy = 0;

// Key handlers:
// Shift down → jumpHeld = true; jumpCursorDx = 0; jumpCursorDy = 0
// Shift up   → jumpHeld = false (release); cursor offsets reset only after the
//              one sample() call that sees the release transition
// While jumpHeld:
//   W tap → jumpCursorDy -= 1 (clamped to -PANEL_JUMP_TARGET_RANGE)
//   S tap → jumpCursorDy += 1 (clamped to +PANEL_JUMP_TARGET_RANGE)
//   A tap → jumpCursorDx -= 1
//   D tap → jumpCursorDx += 1
```

Use keydown listeners, NOT keypressed-state polling — taps are rising-edge events. The same WASD keys also drive movement; while `jumpHeld`, intercept the WASD keydowns and route them to cursor moves, NOT to movement (movement vector is zeroed during a Shift-hold).

- [ ] **Step 5: Held shock + repair.** Keep `shock` as a held boolean (LMB or F held). The server tracks held duration. Drop the existing rising-edge counter for shock — it's no longer rising-edge on the wire.

- [ ] **Step 6: `sample()` returns the new shape**:

```ts
sample(localPlayerPos: { x: number; y: number }): Omit<PlayerInput, 'tick' | 'clientTimeMs'> {
  this.updateFacingFromCursor(localPlayerPos);
  return {
    mx: this.jumpHeld ? 0 : this.movementVectorX(),
    my: this.jumpHeld ? 0 : this.movementVectorY(),
    shock: this.shockHeld,
    repair: this.repairHeld,
    jumpHeld: this.jumpHeld,
    jumpCursorDx: this.jumpCursorDx,
    jumpCursorDy: this.jumpCursorDy,
    facingRad: this.facingRad,
  };
}
```

- [ ] **Step 7: Lint + typecheck.**

Run: `npm run lint --workspace=@gridforce/client && npm run typecheck`

- [ ] **Step 8: Commit**.

```bash
git add packages/client/src
git commit -m "input: cursor-facing capture + Shift jump-target modal; drop sprint"
```

---

## Task 17: main.ts — wire new input + keybinds

**Files:**
- Modify: `packages/client/src/main.ts`

- [ ] **Step 1: Find and update the input wiring.** Pass `localPlayerPos` into `inputCapture.sample(...)`. Wire `inputCapture.setCursorWorldPosCallback(() => cameraController.screenToWorld(mouseScreenPos))`.

- [ ] **Step 2: Rebind keys.** Remove the `KeyP` netsim-cycle binding (P was the previous home for that) if it conflicts with anything else needed. Remove the old Space → dash binding (Space is freed; future use TBD). Remove the Shift → sprint binding (Shift now = jump-target).

Searchable bindings to verify-then-update:
- `KeyF` / mouse LMB → shock (held). Already in place from B1; just confirm it stays held now.
- `KeyR` / mouse RMB → repair (held). Already in place.
- `ShiftLeft` / `ShiftRight` → jump-target hold. NEW.
- `KeyW/A/S/D` → movement OR jump-cursor when Shift held. InputCapture handles this routing.

- [ ] **Step 3: Smoke test in dev.** Run `npm run dev` if it starts cleanly. (Not required for the commit — UI verification lands at the end of the plan.)

- [ ] **Step 4: Typecheck.**

Run: `npm run typecheck`

- [ ] **Step 5: Commit**.

```bash
git add packages/client/src/main.ts
git commit -m "client: wire cursor-facing + Shift jump-target into main"
```

---

## Task 18: GridRenderer — multi-layer rendering

Render the new tile model: LIVE-conductive panel, DAMAGED panel, panel-gone (L0 exposed), passage (L0 gone).

**Files:**
- Modify: `packages/client/src/render/GridRenderer.ts`

- [ ] **Step 1: Replace `setPanelStates(buf: Uint8Array)`** with `setTiles(tiles: TileBuffers)`. Reference-equality short-circuit by storing the last reference.

- [ ] **Step 2: Update `redrawTile(cx, cy)`** to read all four byte arrays:

```ts
import { CONDUCTION_THRESHOLD, L0_DOME_MAX_HP, L1_PANEL_MAX_HP } from '@gridforce/shared';
import { indexOf } from '@gridforce/shared';

private redrawTile(cx: number, cy: number): void {
  const idx = indexOf(this.cols, cx, cy);
  const l1 = this.tiles.l1Hp[idx]!;
  const l0 = this.tiles.l0Hp[idx]!;
  const conductionMin = Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD);
  if (l1 >= conductionMin) {
    // LIVE — bright solar panel.
    this.drawLiveTile(cx, cy);
  } else if (l1 > 0) {
    // DAMAGED — dim panel with crack overlay.
    this.drawDamagedTile(cx, cy, l1 / L1_PANEL_MAX_HP);
  } else if (l0 > 0) {
    // Panel gone; dome exposed.
    this.drawExposedDomeTile(cx, cy, l0 / L0_DOME_MAX_HP);
  } else {
    // Passage — render void / passage sprite.
    this.drawPassageTile(cx, cy);
  }
}
```

Each `draw*` is a placeholder for the implementer: solid colored fill at first (`fill({ color: 0x..., alpha: 1 })`), with a comment that art polish lands in a later spec.

- [ ] **Step 3: main.ts pushes tiles each frame:**

In the frame loop, replace `gridRenderer.setPanelStates(predicted.panelStates)` with `gridRenderer.setTiles(predicted.tiles)`.

- [ ] **Step 4: Smoke test in dev** — `npm run dev`, host a room, start the game. Visually confirm:
  - All-LIVE arena renders as before.
  - When a crawler chews a panel below conduction threshold, the tile dims.
  - When a panel is fully destroyed, a dome sprite shows beneath.
  - When the dome itself is destroyed, the tile reads as a passage.

- [ ] **Step 5: Commit**.

```bash
git add packages/client/src
git commit -m "render: GridRenderer renders 4-state tile (LIVE/DAMAGED/exposed-dome/passage)"
```

---

## Task 19: CameraController — follow + zoom (TDD)

New module. Exposes `viewMatrix` (or `{ x, y, zoom }`) that the renderer applies as a single container transform per frame.

**Files:**
- Create: `packages/client/src/render/CameraController.ts`
- Test: `packages/client/src/render/CameraController.test.ts`

- [ ] **Step 1: Write failing tests**:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraController } from './CameraController.js';

test('CameraController follows the target with smoothing', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 0, y: 0 });
  cam.update(1.0); // 1 second — well past smoothing time constant
  assert.ok(Math.abs(cam.center.x - 0) < 1);
  cam.setTarget({ x: 1000, y: 0 });
  cam.update(1.0); // 1 second — should have effectively converged
  assert.ok(cam.center.x > 900);
});

test('CameraController zoom clamps to min/max', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.zoom(10); // many notches up
  assert.ok(cam.zoomLevel <= 2.0);
  cam.zoom(-10);
  assert.ok(cam.zoomLevel >= 0.5);
});

test('screenToWorld inverts worldToScreen', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 500, y: 300 });
  cam.update(10.0); // converge fully
  const screen = cam.worldToScreen({ x: 500, y: 300 });
  // Centered target is at viewport center.
  assert.ok(Math.abs(screen.x - 400) < 1);
  assert.ok(Math.abs(screen.y - 300) < 1);
  const world = cam.screenToWorld(screen);
  assert.ok(Math.abs(world.x - 500) < 1);
  assert.ok(Math.abs(world.y - 300) < 1);
});
```

- [ ] **Step 2: Implement** `CameraController.ts`:

```ts
import {
  CAMERA_FOLLOW_SMOOTH_S,
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_MIN,
  CAMERA_ZOOM_STEP,
} from '@gridforce/shared';

export interface CameraOpts {
  viewportW: number;
  viewportH: number;
}

export class CameraController {
  center = { x: 0, y: 0 };
  zoomLevel = 1.0;
  private target = { x: 0, y: 0 };
  private viewportW: number;
  private viewportH: number;
  private followEnabled = true;

  constructor(opts: CameraOpts) {
    this.viewportW = opts.viewportW;
    this.viewportH = opts.viewportH;
  }

  setViewportSize(w: number, h: number): void {
    this.viewportW = w;
    this.viewportH = h;
  }

  setTarget(t: { x: number; y: number }): void {
    this.target = { x: t.x, y: t.y };
  }

  zoom(notches: number): void {
    const factor = Math.pow(CAMERA_ZOOM_STEP, notches);
    this.zoomLevel = Math.max(CAMERA_ZOOM_MIN, Math.min(CAMERA_ZOOM_MAX, this.zoomLevel * factor));
  }

  recenter(): void {
    this.followEnabled = true;
  }

  update(dt: number): void {
    if (!this.followEnabled) return;
    // Exponential smoothing toward the target.
    const t = 1 - Math.exp(-dt / CAMERA_FOLLOW_SMOOTH_S);
    this.center.x += (this.target.x - this.center.x) * t;
    this.center.y += (this.target.y - this.center.y) * t;
  }

  worldToScreen(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (p.x - this.center.x) * this.zoomLevel + this.viewportW / 2,
      y: (p.y - this.center.y) * this.zoomLevel + this.viewportH / 2,
    };
  }

  screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (p.x - this.viewportW / 2) / this.zoomLevel + this.center.x,
      y: (p.y - this.viewportH / 2) / this.zoomLevel + this.center.y,
    };
  }
}
```

- [ ] **Step 3: Wire into renderer.** In `Renderer.ts`, instantiate a `CameraController`, call `camera.update(dt)` each frame, then apply the world container transform:

```ts
this.worldContainer.scale.set(camera.zoomLevel);
const screenCenter = camera.worldToScreen({ x: 0, y: 0 });
this.worldContainer.position.set(screenCenter.x, screenCenter.y);
```

Hook mouse wheel → `camera.zoom(notches)`. Hook local player position update → `camera.setTarget(playerPos)`.

- [ ] **Step 4: Run tests — expect PASS. Smoke test in dev.**

- [ ] **Step 5: Commit**.

```bash
git add packages/client/src
git commit -m "render: CameraController with follow + zoom; renderer applies viewMatrix"
```

---

## Task 20: CameraController — free pan + re-center

**Files:**
- Modify: `packages/client/src/render/CameraController.ts`
- Modify: `packages/client/src/main.ts` (wire middle-mouse drag + Home key)

- [ ] **Step 1: Add `pan(dxScreen, dyScreen)` method**:

```ts
pan(dxScreen: number, dyScreen: number): void {
  this.followEnabled = false;
  // Pan in world units = screen delta / zoom (inverted).
  this.center.x -= dxScreen / this.zoomLevel;
  this.center.y -= dyScreen / this.zoomLevel;
}
```

- [ ] **Step 2: Wire middle-mouse drag in `main.ts`**:

Listen for `mousedown` button === 1 → start drag tracking. `mousemove` while dragging → call `camera.pan(deltaX, deltaY)` with frame-to-frame deltas. `mouseup` → end drag.

- [ ] **Step 3: Wire Home key to `camera.recenter()`.**

- [ ] **Step 4: Add a test** for `pan` + `recenter`:

```ts
test('pan disables follow until recenter', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  cam.pan(100, 0); // pan 100 px right (screen) = center moves left 100 world
  assert.ok(cam.center.x < 0);
  // setTarget should NOT pull camera back while panning.
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  assert.ok(cam.center.x < 0);
  // Recenter brings follow back.
  cam.recenter();
  cam.update(10.0);
  assert.ok(Math.abs(cam.center.x) < 1);
});
```

- [ ] **Step 5: Run tests + smoke test. Commit**.

```bash
git add packages/client/src
git commit -m "camera: free pan via middle-drag; Home key recenters to follow"
```

---

## Task 21: CameraController — edge-pan-option (hardcoded off)

**Files:**
- Modify: `packages/client/src/render/CameraController.ts`
- Modify: `packages/client/src/main.ts`

- [ ] **Step 1: Add `setEdgePanEnabled(b: boolean)` + per-frame edge-pan update**:

```ts
private edgePanEnabled = false;

setEdgePanEnabled(b: boolean): void { this.edgePanEnabled = b; }

updateEdgePan(cursorScreen: { x: number; y: number } | null, dt: number): void {
  if (!this.edgePanEnabled || !cursorScreen) return;
  const band = CAMERA_EDGE_PAN_BAND_PX;
  let panX = 0, panY = 0;
  if (cursorScreen.x < band) panX = -1;
  else if (cursorScreen.x > this.viewportW - band) panX = 1;
  if (cursorScreen.y < band) panY = -1;
  else if (cursorScreen.y > this.viewportH - band) panY = 1;
  if (panX === 0 && panY === 0) return;
  this.followEnabled = false;
  const speed = CAMERA_EDGE_PAN_SPEED_PX_S * dt;
  this.center.x += panX * speed / this.zoomLevel;
  this.center.y += panY * speed / this.zoomLevel;
}
```

- [ ] **Step 2: Wire in `main.ts` frame loop**:

```ts
camera.setEdgePanEnabled(CAMERA_EDGE_PAN_DEFAULT); // hard-coded to false; future settings spec exposes the toggle
camera.updateEdgePan(currentCursorScreenPos, dt);
```

- [ ] **Step 3: Smoke test in dev** — flip `CAMERA_EDGE_PAN_DEFAULT` to `true` temporarily, confirm cursor near edge pans the camera, flip back. Commit with the constant `false` (default off).

- [ ] **Step 4: Commit**.

```bash
git add packages/client/src
git commit -m "camera: edge-pan-option (hardcoded off; settings UI is a future spec)"
```

---

## Task 22: JumpTargetOverlay — visual cursor during Shift-hold

**Files:**
- Create: `packages/client/src/ui/JumpTargetOverlay.ts`
- Modify: `packages/client/src/main.ts`

- [ ] **Step 1: Create the overlay** — a Pixi container with:

- A semi-transparent black full-screen fade (alpha ~0.25) under the world.
- A bright outlined square highlighting the target tile at `(playerCx + jumpCursorDx, playerCy + jumpCursorDy)`.
- Optionally, a smaller dimmer marker on the player's current tile for reference.

```ts
export class JumpTargetOverlay {
  visible = false;
  container = new Container();
  // ... internal fields ...

  setVisible(b: boolean): void { this.visible = b; this.container.visible = b; }

  setTargetTile(playerCx: number, playerCy: number, dx: number, dy: number, panelSize: number): void {
    const tx = playerCx + dx, ty = playerCy + dy;
    // Position the highlight rectangle at (tx * panelSize, ty * panelSize) of size panelSize.
    // Draw a 4px bright border.
  }
}
```

- [ ] **Step 2: Wire in main.ts frame loop**:

```ts
const jumpHeld = inputCapture.isJumpHeld(); // expose getter
overlay.setVisible(jumpHeld);
if (jumpHeld) {
  const me = predicted.localPlayer();
  const pcx = Math.floor(me.x / panelSize);
  const pcy = Math.floor(me.y / panelSize);
  overlay.setTargetTile(pcx, pcy, inputCapture.getJumpCursorDx(), inputCapture.getJumpCursorDy(), panelSize);
}
```

- [ ] **Step 3: Smoke test in dev** — hold Shift, tap WASD, confirm the highlight moves tile-by-tile. Release Shift — confirm overlay disappears and player teleports.

- [ ] **Step 4: Commit**.

```bash
git add packages/client/src
git commit -m "ui: JumpTargetOverlay shows tile-cursor while Shift is held"
```

---

## Task 23: MinimapRenderer — tile state + entities + danger + off-screen ping + click-to-pan

**Files:**
- Create: `packages/client/src/render/MinimapRenderer.ts`
- Modify: `packages/client/src/main.ts`
- Test: `packages/client/src/render/MinimapRenderer.test.ts`

- [ ] **Step 1: Write failing tests** for the color-map function (pure function, easy to test without Pixi):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileColor } from './MinimapRenderer.js';
import { L0_DOME_MAX_HP, L1_PANEL_MAX_HP } from '@gridforce/shared';

test('LIVE-conductive tile is bright', () => {
  const c = tileColor(L1_PANEL_MAX_HP, L0_DOME_MAX_HP);
  assert.ok(c.brightness >= 0.8);
  assert.equal(c.kind, 'live');
});

test('DAMAGED tile is amber', () => {
  const c = tileColor(Math.floor(L1_PANEL_MAX_HP * 0.4), L0_DOME_MAX_HP);
  assert.equal(c.kind, 'damaged');
});

test('L1-gone tile is dark (dome visible)', () => {
  const c = tileColor(0, L0_DOME_MAX_HP);
  assert.equal(c.kind, 'dome');
});

test('Passage is red/black', () => {
  const c = tileColor(0, 0);
  assert.equal(c.kind, 'passage');
});
```

- [ ] **Step 2: Implement MinimapRenderer.** Layout:

```ts
import { Container, Graphics } from 'pixi.js';
import {
  CONDUCTION_THRESHOLD,
  L0_DOME_MAX_HP,
  L1_PANEL_MAX_HP,
  MINIMAP_DANGER_WEIGHT_THRESHOLD,
  MINIMAP_SIZE_PX,
} from '@gridforce/shared';

export function tileColor(l1Hp: number, l0Hp: number): { kind: 'live'|'damaged'|'dome'|'passage', color: number, brightness: number } {
  const conductionMin = Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD);
  if (l1Hp >= conductionMin) return { kind: 'live', color: 0x66ccff, brightness: 1.0 };
  if (l1Hp > 0)              return { kind: 'damaged', color: 0xcc8833, brightness: 0.6 };
  if (l0Hp > 0)              return { kind: 'dome', color: 0x333333, brightness: 0.3 };
  return { kind: 'passage', color: 0x550000, brightness: 0.15 };
}

export class MinimapRenderer {
  container = new Container();
  private bg = new Graphics();
  private tilesGfx = new Graphics();
  private entitiesGfx = new Graphics();
  private dangerGfx = new Graphics();
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.container.addChild(this.bg, this.tilesGfx, this.dangerGfx, this.entitiesGfx);
  }

  render(tiles: TileBuffers, players: PlayerState[], crawlers: CrawlerState[], cameraView: { l: number, t: number, r: number, b: number }): void {
    // ... draw tile color grid scaled to MINIMAP_SIZE_PX
    // ... draw player dots (cyan), crawler dots (red)
    // ... compute per-tile weight (4-cardinal+self), highlight tiles with weight >= MINIMAP_DANGER_WEIGHT_THRESHOLD
    // ... for off-screen crawlers (outside cameraView in world coords), blink faster
  }

  // Click-to-pan callback support:
  onClick(screenX: number, screenY: number): { worldX: number, worldY: number } | null {
    // Map click position inside minimap rect to world coordinates.
    // Return null if click is outside the minimap area.
  }
}
```

Off-screen blink: maintain a phase `t` that increments by `dt`; for off-screen crawlers, alpha = `0.4 + 0.6 * sin(t * 10)`; for on-screen crawlers, alpha = 1.0.

- [ ] **Step 3: Wire in main.ts frame loop**:

Each frame, after computing the camera view rect:

```ts
minimap.render(predicted.tiles, predicted.players, predicted.crawlers, cameraViewRect);
```

Click handler: listen for `mousedown` over the minimap bounds; if hit, call `camera.setTargetFromWorld(...)` + `camera.followEnabled = false` (free-pan). Expose a `setCenter(worldPos)` method on `CameraController` to support this:

```ts
// In CameraController:
setCenter(pos: { x: number; y: number }): void {
  this.followEnabled = false;
  this.center.x = pos.x;
  this.center.y = pos.y;
}
```

- [ ] **Step 4: Run tests + smoke test.**

- [ ] **Step 5: Commit**.

```bash
git add packages/client/src
git commit -m "render: MinimapRenderer with tile-state + entity dots + danger + off-screen ping + click-to-pan"
```

---

## Task 24: C1 end-to-end verification + lint/typecheck/build

Smoke-test the full integrated build; run all CI gates.

**Files:**
- Test: `packages/server/src/test/c1-integration.test.ts`

- [ ] **Step 1: Write one integration test** that exercises the full pipeline:

```ts
test('C1 e2e: single-bug attacks panel → L1 grinds down → tile becomes passage; player can shock conductive tiles', async () => {
  const room = makeRoomWithCrawlerAttacking(0, 0);
  // Wait until the L1 panel is destroyed.
  await tickUntil(room, () => room.tiles.l1Hp[indexOf(room.grid.cols, 0, 0)] === 0, 120);
  assert.equal(room.tiles.l0Hp[0]! > 0, true); // L0 still intact
  // Continue until L0 is destroyed too.
  await tickUntil(room, () => room.tiles.l0Hp[indexOf(room.grid.cols, 0, 0)] === 0, 240);
  // The crawler should have transitioned to TRANSITING by now.
  const crawler = Array.from(room.crawlers.values())[0];
  assert.equal(crawler.ai, CrawlerAIState.TRANSITING);
});

test('C1 e2e: cursor-aim uncharged shock kills a single crawler in the cursor direction', () => {
  const room = makeRoomWithCrawlers([[6, 5], [4, 5]]);
  setPlayerAt(room, 5, 5);
  inputPlayer(room, { shock: true, facingRad: 0 });
  tick(room);
  assertCrawlerDead(room, 6, 5);
  assertCrawlerAlive(room, 4, 5);
});

test('C1 e2e: panel-jump teleports via cursor offsets', () => {
  const room = makeRoom();
  setPlayerAt(room, 5, 5);
  inputPlayer(room, { jumpHeld: true, jumpCursorDx: 2, jumpCursorDy: -1 });
  tick(room);
  inputPlayer(room, { jumpHeld: false, jumpCursorDx: 2, jumpCursorDy: -1 });
  tick(room);
  const pl = playerState(room);
  assert.ok(Math.abs(pl.x - (7 * PANEL_SIZE + PANEL_SIZE / 2)) < 1);
  assert.ok(Math.abs(pl.y - (4 * PANEL_SIZE + PANEL_SIZE / 2)) < 1);
});
```

- [ ] **Step 2: Run the full CI suite locally**:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: all green. Fix any lingering test regressions in B1's test files that referenced the old shapes.

- [ ] **Step 3: Manual playthrough.** `npm run dev`. Host a room, start the game.

Confirm visually:
- Walking speed feels noticeably faster than B1.
- Hold Shift → world dims, tile cursor appears on player. WASD moves the cursor by tile. Release → teleport.
- F or LMB → uncharged shock fires in cursor direction; only the one cardinal tile pulses.
- F or LMB held → charge ring builds (placeholder ring acceptable); release after 0.6s → 2-tile line of pulses, conduction-gated.
- Mouse wheel → zoom in/out.
- Hold middle mouse + drag → free pan.
- Home → snap back to player.
- Minimap visible top-right; shows tile state + entity dots; tiles with concentrated bugs glow yellow.
- Single bug slowly grinds a panel; five bugs piled on the same tile collapse it dramatically faster.
- A panel that drops below ~50% HP visually dims and stops conducting; shock at it fizzles.
- When a panel goes fully gone, the dome sprite shows underneath; bugs continue chewing until L0 is gone.
- When L0 is gone, the tile reads as a passage and the bug transits through.

- [ ] **Step 4: Commit + push**.

```bash
git add packages/server/src
git commit -m "tests: C1 e2e integration coverage; full pipeline green"
git push origin <feature-branch>
```

---

## Verification (C1 as a whole)

1. `pnpm -r build` (or `npm run build`) — clean across all workspaces.
2. `npm test` — all tests pass across `@gridforce/{shared,server,client}`.
3. `npm run lint && npm run typecheck` — clean.
4. Manual end-to-end (B1 regression): default `test-run`, host, start. Movement, repair, carbon pickup, panel-degradation all still work.
5. Manual end-to-end (C1 new behaviour): the scenarios in Task 24 step 3, visually confirmed in the browser.
6. Schema mismatch: connect with an old v12 client → server returns SchemaMismatch and the client shows the error.
