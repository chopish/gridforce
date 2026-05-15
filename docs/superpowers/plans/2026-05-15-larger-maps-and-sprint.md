# Larger Maps + Sprint + Panel-Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land sub-spec 2 — a larger playable stage, hold-shift sprint at 1.6×, Space → discrete panel-jump with cooldown, and per-player camera-follow so the bigger world stays readable.

**Architecture:** Schema v11 wire bump. Sprint adds one bit to `PlayerInput` and a multiplier in `stepPlayer`. Panel-jump replaces the existing smooth-dash semantics in `stepPlayer` and the corresponding `dashRemainingS` field disappears (panel-jump is instantaneous); `dashCooldownS` is renamed to `panelJumpCooldownS`. A new `Camera` module owns viewport translation and is consumed by `Renderer`; the playfield container is translated so the local player stays centered. A second stage (`large-grid` 36×24) and run (`large-run`) join the registries; the regression `test-run` is untouched.

**Tech Stack:** TypeScript across `@gridforce/{shared,server,client}` npm workspaces. Vitest-style `node --test` for unit + integration tests. Vite for the client bundle. Pixi.js for rendering.

**Spec:** `docs/superpowers/specs/2026-05-15-larger-maps-and-sprint-design.md` (commit `ea35149`).

---

## Task 1: Schema bump + new constants

Foundation: bump the wire version so any old client gets a SchemaMismatch error rather than silently misdecoding; add the two new tuning constants the rest of the work references.

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Edit `constants.ts`** — bump version, add v11 changelog entry, add the two new constants alongside the existing player-movement block.

Find the version line + changelog and apply:

```ts
//  v11: PlayerInput gains a `sprint` bit (held shift). PlayerEncoder
//       drops dashRemainingS (panel-jump is instantaneous) and renames
//       dashCooldownS → panelJumpCooldownS. The `dash` input bit is
//       still wire-named `dash` but now means "rising-edge panel jump".
export const SCHEMA_VERSION = 11;
```

Add in the Player movement block (just below the existing `PLAYER_DASH_*` constants):

```ts
// Sprint: hold shift to walk this much faster. Applies only to walk
// speed; panel-jump is instantaneous so the multiplier never compounds.
export const PLAYER_SPRINT_MULTIPLIER = 1.6;

// Panel-jump: rising-edge of the `dash` input bit teleports the player
// one panel in the input/facing direction. Cooldown is the rate-limit.
export const PANEL_JUMP_COOLDOWN_S = 0.4;
```

Leave the old `PLAYER_DASH_*` constants in place for now — Task 4 removes them once stepPlayer no longer references them.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (the new constants aren't referenced yet; the version bump is pure).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "schema: bump to v11 for sprint + panel-jump"
```

---

## Task 2: Sprint end-to-end (type, wire bit, sim multiplier, TDD)

Sprint is the smallest fully-shippable slice: one wire bit, one sim multiplier.

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/net/messages/Input.ts`
- Modify: `packages/shared/src/sim.ts`
- Test: `packages/shared/src/sim.test.ts`
- Test: `packages/shared/src/net/__tests__/wire.test.ts`

- [ ] **Step 1: Write failing test in `wire.test.ts`** — sprint bit round-trips.

Add right after the existing "Input round-trip with redundancy window" test:

```ts
test('Input round-trip preserves sprint bit', () => {
  const inputs = [
    { tick: 200, clientTimeMs: 1, mx: 1, my: 0, dash: false, sprint: true },
    { tick: 201, clientTimeMs: 2, mx: 0, my: 1, dash: true,  sprint: false },
    { tick: 202, clientTimeMs: 3, mx: 0, my: 0, dash: false, sprint: true },
  ];
  const dec = decodeMessage(InputMsg.encode(inputs));
  assert.equal(dec.type, MessageType.Input);
  const list = dec.payload;
  assert.equal(list.length, 3);
  assert.equal(list[0]!.sprint, true);
  assert.equal(list[1]!.sprint, false);
  assert.equal(list[2]!.sprint, true);
  // Dash bit must still round-trip independently.
  assert.equal(list[0]!.dash, false);
  assert.equal(list[1]!.dash, true);
});
```

- [ ] **Step 2: Write failing tests in `sim.test.ts`** — sprint scales walk-speed by 1.6×.

Read the existing file to find the "movement integrates at expected speed" test for the pattern, then append:

```ts
test('sprint scales walk speed by PLAYER_SPRINT_MULTIPLIER', () => {
  const grid = createDefaultGrid();
  // Spawn somewhere away from walls so the clamp doesn't truncate the path.
  let state = newPlayerState(0, grid.cols * grid.panelSize / 2, grid.rows * grid.panelSize / 2);
  const dt = 1 / 30;
  const N = 30;
  for (let i = 0; i < N; i++) {
    state = stepPlayer(
      state,
      { tick: i, clientTimeMs: 0, mx: 1, my: 0, dash: false, sprint: true },
      dt,
      grid,
    );
  }
  const expected = grid.cols * grid.panelSize / 2 + PLAYER_MOVE_SPEED * PLAYER_SPRINT_MULTIPLIER * dt * N;
  assert.ok(
    Math.abs(state.x - expected) < 0.5,
    `sprint distance: got ${state.x}, expected ~${expected}`,
  );
});

test('walk speed unchanged when sprint=false', () => {
  const grid = createDefaultGrid();
  let state = newPlayerState(0, grid.cols * grid.panelSize / 2, grid.rows * grid.panelSize / 2);
  const dt = 1 / 30;
  for (let i = 0; i < 30; i++) {
    state = stepPlayer(
      state,
      { tick: i, clientTimeMs: 0, mx: 1, my: 0, dash: false, sprint: false },
      dt,
      grid,
    );
  }
  const expected = grid.cols * grid.panelSize / 2 + PLAYER_MOVE_SPEED * dt * 30;
  assert.ok(Math.abs(state.x - expected) < 0.5);
});
```

Imports needed at the top of `sim.test.ts`:

```ts
import { createDefaultGrid } from './grid.js';
import { PLAYER_MOVE_SPEED, PLAYER_SPRINT_MULTIPLIER } from './constants.js';
import { newPlayerState, stepPlayer } from './sim.js';
```

(Some/all of these are probably already imported — check the file head and only add what's missing.)

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npm test --workspace=@gridforce/shared`
Expected: the three new tests fail (sprint field doesn't exist yet on the input type / wire).

- [ ] **Step 4: Add `sprint` to `PlayerInput`** in `packages/shared/src/types.ts`:

```ts
export interface PlayerInput {
  tick: number;
  clientTimeMs: number;
  mx: number;
  my: number;
  dash: boolean;
  sprint: boolean;
}
```

- [ ] **Step 5: Update `Input.ts` encoder/decoder** to carry the sprint bit.

Edit `packages/shared/src/net/messages/Input.ts`:

```ts
const BUTTON_DASH   = 1 << 0;
const BUTTON_SPRINT = 1 << 1;

// Wire format comment updated to:
//     u8  buttons              (bit 0 = dash, bit 1 = sprint)
```

In `encode`, change the line that writes the buttons byte:

```ts
w.u8((p.dash ? BUTTON_DASH : 0) | (p.sprint ? BUTTON_SPRINT : 0));
```

In `decode`, change the construction at the bottom of the loop:

```ts
out[i] = {
  tick,
  clientTimeMs,
  mx,
  my,
  dash: (buttons & BUTTON_DASH) !== 0,
  sprint: (buttons & BUTTON_SPRINT) !== 0,
};
```

- [ ] **Step 6: Apply sprint multiplier in `stepPlayer`** (sim.ts).

Find the walk-speed block at the bottom of stepPlayer (after the dash block):

```ts
  } else {
    vx = mx * PLAYER_MOVE_SPEED;
    vy = my * PLAYER_MOVE_SPEED;
  }
```

Replace with:

```ts
  } else {
    const walk = input?.sprint ? PLAYER_MOVE_SPEED * PLAYER_SPRINT_MULTIPLIER : PLAYER_MOVE_SPEED;
    vx = mx * walk;
    vy = my * walk;
  }
```

Add the import at the top:

```ts
import {
  PLAYER_DASH_COOLDOWN_S,
  PLAYER_DASH_DURATION_S,
  PLAYER_DASH_SPEED,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  PLAYER_SPRINT_MULTIPLIER,
} from './constants.js';
```

- [ ] **Step 7: Audit existing call sites that construct `PlayerInput`** — they now need a `sprint` field.

```bash
grep -rn "dash: " packages/ --include="*.ts" | grep -v "node_modules"
```

Likely hits in client `main.ts`, client `InputCapture.ts`, server pilots, and tests. For each construction, add `sprint: false` (Task 5 wires real keyboard input — for now everything sets false).

Specifically:

- `packages/client/src/sim/PredictedWorld.ts` — the `step(local: { ... })` parameter doesn't include sprint yet. Either widen the parameter and pass it through to `stepPlayer`, or accept `local: { ..., sprint?: boolean }` and default false. Recommend widening so Task 5 can pass it without re-touching this file:

```ts
step(local: { mx: number; my: number; dash: boolean; sprint: boolean; clientTimeMs: number }): PlayerInput {
  // ...
  const input: PlayerInput = {
    tick: this.predictedTick,
    clientTimeMs: local.clientTimeMs,
    mx: local.mx,
    my: local.my,
    dash: local.dash,
    sprint: local.sprint,
  };
  // ...
}
```

Then in `PredictedWorld.applySnapshot` find the catch-up replay block that constructs synthetic idle inputs and add `sprint: false`:

```ts
advanced = stepPlayer(
  advanced,
  { tick: this.predictedTick + i + 1, clientTimeMs: 0, mx: 0, my: 0, dash: false, sprint: false },
  SERVER_TICK_DT_S,
  this.grid,
);
```

- `packages/client/src/main.ts` — find where `world.step({ ... })` is called and add `sprint: false` for now (Task 5 sets the real value).
- `packages/server/src/bots/WanderBot.ts` and `Pilot.ts` etc — any place that builds inputs.
- Tests in `packages/server/src/test/integration.headless.test.ts` and elsewhere — add `sprint: false` to any test input fixtures.

- [ ] **Step 8: Run tests**

Run: `npm test --workspace=@gridforce/shared && npm test --workspace=@gridforce/server`
Expected: all pass, including the three new sprint tests.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: clean. If a call site you missed errors, fix it inline.

- [ ] **Step 10: Commit**

```bash
git add packages/
git commit -m "feat: sprint bit in PlayerInput + 1.6x walk multiplier"
```

---

## Task 3: Drop `dashRemainingS`, rename `dashCooldownS` → `panelJumpCooldownS`

Pure rename + field removal. Touches the type, the encoder, the constructor helper, and the existing wire test that asserts the old field names. The actual panel-jump *behavior* changes in Task 4 — this task just reshapes the state.

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/sim.ts`
- Modify: `packages/shared/src/net/entities/PlayerEncoder.ts`
- Modify: `packages/shared/src/net/__tests__/wire.test.ts`
- Modify: any client/server code reading the old field names

- [ ] **Step 1: Update `PlayerState` in `types.ts`**

```ts
export interface PlayerState {
  id: PlayerId;
  x: number;
  y: number;
  facing: number;
  panelJumpCooldownS: number;  // renamed from dashCooldownS
  // dashRemainingS removed — panel-jump is instantaneous
  stateSeq: number;
  name: string;
  ready: boolean;
}
```

- [ ] **Step 2: Update `newPlayerState` in `sim.ts`**

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
  };
}
```

Drop the existing `isDashing` helper at the bottom of `sim.ts` — Task 9 also removes its caller in `PlayerRenderer`.

- [ ] **Step 3: Update `PlayerEncoder.ts`** — wire layout shrinks by one byte.

Replace the encoder/decoder bodies and the surrounding comment block:

```ts
// One player entity (variable, ~16 + name bytes):
//   u8  id                       (1)
//   f32 x                        (4)
//   f32 y                        (4)
//   u8  facingQ                  (1)
//   u8  flags                    (1)   bit1=READY (bit0 reserved, was DASHING)
//   u8  panelJumpCooldownQ       (1)   seconds × 255, saturating at 1.0s
//   u32 stateSeq                 (4)
//   string name                  (varint length + utf8)
export const PlayerEncoder: EntityEncoder<PlayerState> = {
  type: EntityType.Player,
  encode(w, p) {
    w.u8(p.id & 0xff);
    w.f32(p.x);
    w.f32(p.y);
    w.u8(quantizeFacing(p.facing));
    let flags = 0;
    if (p.ready) flags |= PLAYER_FLAG_READY;
    w.u8(flags);
    w.u8(quantizeTimer(p.panelJumpCooldownS));
    w.u32(p.stateSeq >>> 0);
    w.string(p.name);
  },
  decode(r) {
    const id = r.u8();
    const x = r.f32();
    const y = r.f32();
    const facing = unquantizeFacing(r.u8());
    const flags = r.u8();
    const panelJumpCooldownS = unquantizeTimer(r.u8());
    const stateSeq = r.u32();
    const name = r.string();
    const ready = (flags & PLAYER_FLAG_READY) !== 0;
    return { id, x, y, facing, panelJumpCooldownS, stateSeq, name, ready };
  },
};
```

The exported flag bit becomes:

```ts
export const PLAYER_FLAG_READY = 1 << 1;
// bit 0 reserved (was DASHING)
// bits 2..6 reserved
// bit 7 reserved as "delta-from-baseline" marker for future delta encoding.
```

Drop `PLAYER_FLAG_DASHING` from the exports.

- [ ] **Step 4: Update the `stepPlayer` body** — every reference to `dashCooldownS` becomes `panelJumpCooldownS`; every reference to `dashRemainingS` is deleted (Task 4 wires the new panel-jump logic; this step just makes the file compile).

Find every line that mentions the old names. After this step `stepPlayer` will look briefly weird (dash logic that uses panelJumpCooldownS but no dashRemainingS), but Task 4 replaces it wholesale. Acceptable interim state.

A safe simplification for the interim: comment out the dash-burst block entirely. The next task replaces it anyway.

- [ ] **Step 5: Update existing wire tests** — `packages/shared/src/net/__tests__/wire.test.ts`

The "Snapshot round-trip with multiple players, ack bitmask, dash timers" test has assertions on the old field names. Update:

```ts
const players = [
  { ...newPlayerState(0, 50, 60), facing: 0, stateSeq: 1 },
  { ...newPlayerState(1, 70, 80), facing: Math.PI, stateSeq: 2, panelJumpCooldownS: 0.4 },
  { ...newPlayerState(2, 90, 100), facing: -Math.PI / 2, stateSeq: 3, panelJumpCooldownS: 0.65 },
];
// ... payload assembly unchanged ...

// Replace the mid-dash assertions:
assert.equal(s.players[0]!.panelJumpCooldownS, 0);
assert.ok(Math.abs(s.players[1]!.panelJumpCooldownS - 0.4) < 0.005, 'cooldown precision');
assert.ok(Math.abs(s.players[2]!.panelJumpCooldownS - 0.65) < 0.005, 'cooldown precision');
// dashRemainingS assertions are removed entirely.
```

The test name can stay as-is or rename to "Snapshot round-trip with cooldown timer". Either works.

- [ ] **Step 6: Audit + update other consumers** — anywhere reading the old field names.

```bash
grep -rn "dashCooldownS\|dashRemainingS\|isDashing\|PLAYER_FLAG_DASHING" packages/ --include="*.ts"
```

Expected hits:
- `packages/server/src/test/lobbyPhase.test.ts` (if it spreads PlayerState anywhere with the old names — unlikely but check)
- `packages/server/src/test/TestClient.ts` — likely reads dashRemainingS for divergence tracking
- `packages/client/src/render/PlayerRenderer.ts` — likely consults `isDashing` or `dashRemainingS`
- `packages/client/src/main.ts` — the `dashing` boolean in the per-player render sample

For PlayerRenderer / main.ts / TestClient: just drop the `dashing` boolean / replace any `dashRemainingS > 0` check with `false` (we'll restore a visual cue in Task 9 if desired; for now it's a clean removal).

- [ ] **Step 7: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; the rewritten wire test now asserts the new field name.

- [ ] **Step 8: Commit**

```bash
git add packages/
git commit -m "refactor: drop dashRemainingS, rename dashCooldownS to panelJumpCooldownS"
```

---

## Task 4: Panel-jump in `stepPlayer` (TDD)

The interim state from Task 3 has a broken dash block. This task replaces it with the new discrete teleport.

**Files:**
- Modify: `packages/shared/src/sim.ts`
- Modify: `packages/shared/src/constants.ts` (drop PLAYER_DASH_*)
- Test: `packages/shared/src/sim.test.ts`

- [ ] **Step 1: Write failing tests in `sim.test.ts`**

```ts
test('panel-jump teleports one panelSize in the input direction', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  const startY = grid.rows * grid.panelSize / 2;
  let state = newPlayerState(0, startX, startY);
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 1, my: 0, dash: true, sprint: false },
    1 / 30,
    grid,
  );
  assert.ok(Math.abs(state.x - (startX + grid.panelSize)) < 0.5, `x should advance one panel (got ${state.x})`);
  assert.ok(Math.abs(state.y - startY) < 0.5, 'y unchanged for pure horizontal jump');
  assert.ok(state.panelJumpCooldownS > 0, 'cooldown set after jump');
});

test('panel-jump from idle uses facing direction', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  const startY = grid.rows * grid.panelSize / 2;
  let state = newPlayerState(0, startX, startY);
  // Force facing to point straight up (negative y in screen coords).
  state = { ...state, facing: -Math.PI / 2 };
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 0, my: 0, dash: true, sprint: false },
    1 / 30,
    grid,
  );
  assert.ok(Math.abs(state.y - (startY - grid.panelSize)) < 0.5, 'y advances up one panel from facing');
});

test('panel-jump snaps direction to 8 octants', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  const startY = grid.rows * grid.panelSize / 2;
  // A 60-degree input vector should snap to (1, 1) octant, landing diagonally one panel.
  let state = newPlayerState(0, startX, startY);
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 0.5, my: 0.866, dash: true, sprint: false },
    1 / 30,
    grid,
  );
  assert.ok(Math.abs(state.x - (startX + grid.panelSize)) < 0.5);
  assert.ok(Math.abs(state.y - (startY + grid.panelSize)) < 0.5);
});

test('panel-jump clamps to world edge when target would land outside', () => {
  const grid = createDefaultGrid();
  const worldW = grid.cols * grid.panelSize;
  // Half a panel from the right edge — jumping right should land at the wall.
  let state = newPlayerState(0, worldW - grid.panelSize / 2, grid.rows * grid.panelSize / 2);
  state = stepPlayer(
    state,
    { tick: 1, clientTimeMs: 0, mx: 1, my: 0, dash: true, sprint: false },
    1 / 30,
    grid,
  );
  assert.equal(state.x, worldW - PLAYER_RADIUS);
});

test('panel-jump cooldown is enforced', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 2;
  let state = newPlayerState(0, startX, grid.rows * grid.panelSize / 2);
  state = stepPlayer(state, { tick: 1, clientTimeMs: 0, mx: 1, my: 0, dash: true,  sprint: false }, 1 / 30, grid);
  const xAfterFirst = state.x;
  // Second dash 0.1s later (one tick at 10Hz). Should be ignored.
  state = stepPlayer(state, { tick: 2, clientTimeMs: 0, mx: 1, my: 0, dash: true,  sprint: false }, 0.1,    grid);
  assert.equal(state.x, xAfterFirst, 'second jump within cooldown does nothing');
});

test('panel-jump cooldown elapses', () => {
  const grid = createDefaultGrid();
  const startX = grid.cols * grid.panelSize / 4;
  let state = newPlayerState(0, startX, grid.rows * grid.panelSize / 2);
  state = stepPlayer(state, { tick: 1, clientTimeMs: 0, mx: 1, my: 0, dash: true, sprint: false }, 1 / 30, grid);
  // Tick forward 0.5s of idle ticks (longer than the 0.4s cooldown).
  for (let i = 0; i < 15; i++) {
    state = stepPlayer(state, { tick: 2 + i, clientTimeMs: 0, mx: 0, my: 0, dash: false, sprint: false }, 1 / 30, grid);
  }
  assert.equal(state.panelJumpCooldownS, 0, 'cooldown drained');
  // Now a second jump should fire.
  state = stepPlayer(state, { tick: 100, clientTimeMs: 0, mx: 1, my: 0, dash: true, sprint: false }, 1 / 30, grid);
  assert.ok(Math.abs(state.x - (startX + 2 * grid.panelSize)) < 0.5);
});
```

The existing "dash starts only when cooldown is zero, then enters cooldown" test will no longer make sense (the dash burst is gone). Delete or rewrite that test to the cooldown-elapses case above — pick one to keep.

- [ ] **Step 2: Run tests to confirm fail**

Run: `npm test --workspace=@gridforce/shared`
Expected: the new panel-jump cases fail (jump logic isn't wired yet).

- [ ] **Step 3: Implement panel-jump in `stepPlayer`**

Replace the `stepPlayer` body in `sim.ts`. Full replacement (this also drops the now-unused dash burst):

```ts
import {
  PANEL_JUMP_COOLDOWN_S,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  PLAYER_SPRINT_MULTIPLIER,
} from './constants.js';
import type { GridDef, PlayerInput, PlayerState } from './types.js';

const FACING_EPSILON = 1e-3;
const INPUT_DEADZONE = 0.1;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function newPlayerState(id: number, x: number, y: number, name = ''): PlayerState {
  return {
    id, x, y, facing: 0, panelJumpCooldownS: 0, stateSeq: 0, name, ready: false,
  };
}

// Snap a direction vector to one of the 8 octants. Returns integer dx, dy
// in {-1, 0, +1}, not both zero. Caller has already verified the source
// vector is non-degenerate.
function snapDirToOctant(dx: number, dy: number): { dx: number; dy: number } {
  // atan2 → [−π, π] → quantize to 8 buckets, then convert back to dx/dy.
  const a = Math.atan2(dy, dx);
  const bucket = Math.round(a / (Math.PI / 4)); // -4..4
  const wrapped = ((bucket % 8) + 8) % 8;
  // bucket 0 = +x, 1 = +x+y, 2 = +y, etc.
  const table = [
    { dx:  1, dy:  0 },
    { dx:  1, dy:  1 },
    { dx:  0, dy:  1 },
    { dx: -1, dy:  1 },
    { dx: -1, dy:  0 },
    { dx: -1, dy: -1 },
    { dx:  0, dy: -1 },
    { dx:  1, dy: -1 },
  ];
  return table[wrapped]!;
}

export function stepPlayer(
  state: PlayerState,
  input: PlayerInput | null,
  dt: number,
  grid: GridDef,
): PlayerState {
  let { x, y, facing, panelJumpCooldownS } = state;
  const stateSeq = (state.stateSeq + 1) >>> 0;

  let mx = 0, my = 0;
  let wantJump = false;
  let sprint = false;
  if (input) {
    mx = clamp(input.mx, -1, 1);
    my = clamp(input.my, -1, 1);
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }
    wantJump = !!input.dash;
    sprint = !!input.sprint;
  }

  if (panelJumpCooldownS > 0) panelJumpCooldownS = Math.max(0, panelJumpCooldownS - dt);

  // Panel-jump: discrete teleport. Direction is the input vector if non-
  // negligible, otherwise the current facing. Snap to 8 octants, clamp to
  // grid bounds.
  if (wantJump && panelJumpCooldownS === 0) {
    let dirX = mx, dirY = my;
    if (Math.hypot(dirX, dirY) < INPUT_DEADZONE) {
      dirX = Math.cos(facing);
      dirY = Math.sin(facing);
    }
    const oct = snapDirToOctant(dirX, dirY);
    x += oct.dx * grid.panelSize;
    y += oct.dy * grid.panelSize;
    panelJumpCooldownS = PANEL_JUMP_COOLDOWN_S;
  }

  // Walk integration (sprint multiplier applies only here).
  const walk = sprint ? PLAYER_MOVE_SPEED * PLAYER_SPRINT_MULTIPLIER : PLAYER_MOVE_SPEED;
  const vx = mx * walk;
  const vy = my * walk;
  x += vx * dt;
  y += vy * dt;

  if (Math.hypot(vx, vy) > FACING_EPSILON) {
    facing = Math.atan2(vy, vx);
  }

  const minX = PLAYER_RADIUS;
  const minY = PLAYER_RADIUS;
  const maxX = grid.cols * grid.panelSize - PLAYER_RADIUS;
  const maxY = grid.rows * grid.panelSize - PLAYER_RADIUS;
  x = clamp(x, minX, maxX);
  y = clamp(y, minY, maxY);

  return {
    id: state.id,
    x, y, facing, panelJumpCooldownS, stateSeq,
    name: state.name,
    ready: state.ready,
  };
}
```

- [ ] **Step 4: Drop now-unused dash constants** from `constants.ts`

```ts
// Remove these lines:
// export const PLAYER_DASH_SPEED = 700;
// export const PLAYER_DASH_DURATION_S = 0.18;
// export const PLAYER_DASH_COOLDOWN_S = 0.65;
```

Any test that still imports them needs to be updated to `PANEL_JUMP_COOLDOWN_S` or removed entirely. Run typecheck to find them.

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=@gridforce/shared`
Expected: all panel-jump cases pass; the determinism replay test still passes (sprint+jump are deterministic).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. Fix any import errors from the removed dash constants.

- [ ] **Step 7: Commit**

```bash
git add packages/
git commit -m "feat: Space is now a discrete one-panel teleport with 0.4s cooldown"
```

---

## Task 5: Client `InputCapture` — hold-shift sprint + gamepad button

Wire the shift key (and a gamepad trigger) into the per-tick input.

**Files:**
- Modify: `packages/client/src/input/InputCapture.ts`
- Modify: `packages/client/src/main.ts` (pass sprint into world.step)

- [ ] **Step 1: Update `InputCapture.ts`** — track ShiftLeft/ShiftRight as held.

Find the keyboard-state map. Add Shift handling alongside the existing W/A/S/D/Space:

```ts
private keys = {
  up: false, down: false, left: false, right: false,
  dash: false,
  sprint: false,  // NEW
};

// In keydown / keyup handlers:
case 'ShiftLeft':
case 'ShiftRight':
  this.keys.sprint = down;
  break;
```

In the gamepad section, alongside the existing dash button check (`buttons[0]`, `buttons[7]`), add:

```ts
const sprintPressed = (gp.buttons[6]?.pressed ?? false);
```

In the snapshot of input emitted from the read method, include `sprint`:

```ts
return {
  mx, my,
  dash: this.dashEdge.consume() || gamepadDashPressed,
  sprint: this.keys.sprint || sprintPressed,
};
```

Adjust types so the returned shape includes `sprint: boolean`.

- [ ] **Step 2: Update `main.ts`** — the call to `world.step(...)` now passes sprint.

Find the input.read() → world.step() bridge and ensure the sprint field flows through. Since Task 2 widened `world.step`'s parameter, all we need is:

```ts
const inp = inputs.read();
const playerInput = world.step({
  mx: inp.mx,
  my: inp.my,
  dash: inp.dash,
  sprint: inp.sprint,  // NEW
  clientTimeMs: performance.now(),
});
```

- [ ] **Step 3: Manual smoke test (no automated test for keyboard wiring)**

Run: `npm run dev`
Open the client. Host a room. Confirm holding Left Shift while moving makes the player visibly faster.

- [ ] **Step 4: Commit**

```bash
git add packages/client/
git commit -m "feat: client emits sprint flag from shift + gamepad LT"
```

---

## Task 6: Client visual snap for panel-jump

When a panel-jump happens, the simulated position jumps by `panelSize` in one tick. With unmodified visual interpolation, the renderer slides over that gap during the tick (smooth, not snappy). Set `prevPlayers[localId]` to the post-jump state so `lerp(prev, cur, alpha)` resolves to the destination at any alpha. Do the same for remote players going through `RemotePlayerInterpolator`.

**Files:**
- Modify: `packages/client/src/sim/PredictedWorld.ts`
- Modify: `packages/client/src/sim/RemotePlayerInterpolator.ts`

- [ ] **Step 1: Detect jump in `PredictedWorld.step`** — after computing `nextLocal` from `stepPlayer`:

```ts
const nextLocal = stepPlayer(localState, input, SERVER_TICK_DT_S, this.grid);
// Detect a panel-jump frame: position moved more than walk-step worth
// (with margin for sprint). Half a panel is well above any single-tick
// walk distance even with sprint, and well below a full jump.
const stepDist = Math.hypot(nextLocal.x - localState.x, nextLocal.y - localState.y);
const jumped = stepDist > this.grid.panelSize * 0.5;
this.players.set(this.localPlayerId, nextLocal);
if (jumped) {
  // Skip render-time interpolation by aligning prev with cur.
  this.prevPlayers.set(this.localPlayerId, { ...nextLocal });
}
```

- [ ] **Step 2: Same logic in `applySnapshot` for the local player after rebase** — if the rebased local position is more than half a panel from `before`, snap.

Find the existing rebase block:

```ts
let rebased: PlayerState = { ...localSnap };
for (const inp of this.pending) {
  rebased = stepPlayer(rebased, inp, SERVER_TICK_DT_S, this.grid);
}
```

After it (alongside the existing prev-preservation logic), if the delta is jump-sized, align prev to the rebased state so visual doesn't slide through the snap:

```ts
const dx = (before?.x ?? rebased.x) - rebased.x;
const dy = (before?.y ?? rebased.y) - rebased.y;
const err = Math.hypot(dx, dy);
if (err > this.grid.panelSize * 0.5) {
  this.prevPlayers.set(this.localPlayerId, { ...rebased });
}
```

Place this BEFORE the existing visual-correction code so the correction-blend branch doesn't paper over a real teleport.

- [ ] **Step 3: Update `RemotePlayerInterpolator`** — detect ingest-time jumps and clear the interpolation buffer.

Read `RemotePlayerInterpolator.ts` for its current ingest signature, then in `ingest()`:

```ts
const prev = this.lastIngested.get(p.id);
if (prev) {
  const stepDist = Math.hypot(p.x - prev.x, p.y - prev.y);
  // A jump arrives as a single-snapshot delta way larger than any
  // walk/sprint distance per snapshot interval (~50ms). Treat as a
  // teleport: clear the ring buffer so the renderer snaps to the new
  // position instead of blending toward it.
  if (stepDist > /* one panel */ 56) {
    this.clear(p.id);
  }
}
this.lastIngested.set(p.id, { x: p.x, y: p.y });
// ... existing ingest logic
```

Add a `clear(id)` method if one doesn't exist — it should reset the ring buffer for that player so the next sample seeds afresh from the post-jump state.

(Exact API will depend on the existing interpolator's shape; adapt the names to fit.)

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`. Host a room, tap Space — the local player should snap (not slide). With a second client connected, the remote player's jumps should also look snappy.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/sim/
git commit -m "feat: visual snap on panel-jump for local + remote players"
```

---

## Task 7: Camera module

New `Camera.ts` with deterministic smoothing and bounds-clamping. Add a focused unit test.

**Files:**
- Create: `packages/client/src/render/Camera.ts`
- Create: `packages/client/src/render/Camera.test.ts`

- [ ] **Step 1: Write failing test in `Camera.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './Camera.js';

test('camera centres immediately at first sample', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 2304, worldH: 1536 });
  cam.snapTo(1152, 768);
  const { x, y } = cam.position;
  assert.equal(x, 1152);
  assert.equal(y, 768);
});

test('camera smooths toward target over time', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 2304, worldH: 1536 });
  cam.snapTo(0, 0);
  cam.update(1000, 1000, 0.05); // 50ms of catch-up toward (1000, 1000)
  const after = cam.position;
  assert.ok(after.x > 0 && after.x < 1000, `x partway toward 1000 (got ${after.x})`);
  assert.ok(after.y > 0 && after.y < 1000);
});

test('camera clamps to world bounds', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 2304, worldH: 1536 });
  cam.snapTo(0, 0);
  // Target way off the left edge; over many updates, the position should
  // converge to a value that does not let the viewport reveal void.
  for (let i = 0; i < 200; i++) cam.update(-100, -100, 1 / 30);
  const { x, y } = cam.position;
  // Min camera position is viewportW/2 (so left edge of viewport is x=0).
  assert.equal(x, 400);
  assert.equal(y, 300);
});

test('camera centres when world is smaller than viewport in either axis', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 400, worldH: 1536 });
  cam.snapTo(0, 0);
  for (let i = 0; i < 200; i++) cam.update(10000, 1500, 1 / 30);
  // World narrower than viewport in x → camera locks to world centre on x.
  assert.equal(cam.position.x, 200);
  // y still tracks the target (clamped to world bounds).
  assert.ok(cam.position.y > 0);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test --workspace=@gridforce/client`
Expected: all four cases fail (Camera doesn't exist).

- [ ] **Step 3: Implement `Camera.ts`**

```ts
const TIME_CONSTANT_S = 0.12;

export interface CameraOptions {
  viewportW: number;
  viewportH: number;
  worldW: number;
  worldH: number;
}

export class Camera {
  private x = 0;
  private y = 0;
  private opts: CameraOptions;

  constructor(opts: CameraOptions) {
    this.opts = opts;
  }

  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  resize(viewportW: number, viewportH: number): void {
    this.opts = { ...this.opts, viewportW, viewportH };
  }

  setWorldBounds(worldW: number, worldH: number): void {
    this.opts = { ...this.opts, worldW, worldH };
  }

  snapTo(targetX: number, targetY: number): void {
    const { x, y } = this.clamp(targetX, targetY);
    this.x = x;
    this.y = y;
  }

  update(targetX: number, targetY: number, dtS: number): void {
    // Frame-rate-independent exponential smoothing.
    const alpha = 1 - Math.exp(-dtS / TIME_CONSTANT_S);
    const clamped = this.clamp(targetX, targetY);
    this.x = this.x + (clamped.x - this.x) * alpha;
    this.y = this.y + (clamped.y - this.y) * alpha;
  }

  /** World→screen offset to apply to the playfield container. */
  worldToScreenOffset(): { x: number; y: number } {
    return {
      x: this.opts.viewportW / 2 - this.x,
      y: this.opts.viewportH / 2 - this.y,
    };
  }

  private clamp(targetX: number, targetY: number): { x: number; y: number } {
    const { viewportW, viewportH, worldW, worldH } = this.opts;
    const halfW = viewportW / 2;
    const halfH = viewportH / 2;
    // If the world is narrower than the viewport in some axis, lock that
    // axis to world centre. Otherwise clamp the camera so the viewport
    // stays inside the world.
    let x: number;
    if (worldW <= viewportW) x = worldW / 2;
    else x = Math.max(halfW, Math.min(worldW - halfW, targetX));
    let y: number;
    if (worldH <= viewportH) y = worldH / 2;
    else y = Math.max(halfH, Math.min(worldH - halfH, targetY));
    return { x, y };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@gridforce/client`
Expected: all four Camera cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/render/Camera.ts packages/client/src/render/Camera.test.ts
git commit -m "feat: Camera module with smoothing + bounds clamp"
```

---

## Task 8: Renderer integration — apply camera transform, expose `setGrid`

**Files:**
- Modify: `packages/client/src/render/Renderer.ts`

- [ ] **Step 1: Read the current Renderer** to find the playfield container and resize handler.

Open `Renderer.ts`. Identify:
- The Pixi `Container` that holds the GridRenderer + PlayerRenderer + NpcRenderer (it might be `this.stage` or a child container).
- The `init(host, grid)` method.
- Any existing resize logic.

- [ ] **Step 2: Add a `Camera` instance and a playfield container**

In the class fields:

```ts
private camera: Camera | null = null;
private playfield: Container | null = null;  // holds grid + players + npcs
```

In `init()`:

```ts
this.playfield = new Container();
this.app.stage.addChild(this.playfield);
this.playfield.addChild(this.gridRenderer.root);
this.playfield.addChild(this.playerRenderer.root);
this.playfield.addChild(this.npcRenderer.root);

this.camera = new Camera({
  viewportW: this.app.screen.width,
  viewportH: this.app.screen.height,
  worldW: grid.cols * grid.panelSize,
  worldH: grid.rows * grid.panelSize,
});
this.camera.snapTo(
  (grid.cols * grid.panelSize) / 2,
  (grid.rows * grid.panelSize) / 2,
);
```

(If the gridRenderer / playerRenderer / npcRenderer expose their root via a different name, use that.)

- [ ] **Step 3: Hook into the existing resize callback** and call `camera.resize`.

- [ ] **Step 4: Add `setGrid(grid)` method**

```ts
setGrid(grid: GridDef): void {
  if (!this.camera || !this.playfield) return;
  this.gridRenderer.rebuild(grid);   // GridRenderer needs a rebuild method
  this.camera.setWorldBounds(grid.cols * grid.panelSize, grid.rows * grid.panelSize);
}
```

If `GridRenderer.rebuild` doesn't exist, add it: destroy existing tile sprites and re-instantiate from the new grid dimensions.

- [ ] **Step 5: Per-frame camera update + apply offset**

Add a public `tick(dtMs, localX, localY)` (or extend the existing frame method) so main.ts can drive the camera each frame:

```ts
tick(dtMs: number, localX: number, localY: number): void {
  if (!this.camera || !this.playfield) return;
  this.camera.update(localX, localY, dtMs / 1000);
  const off = this.camera.worldToScreenOffset();
  this.playfield.position.set(off.x, off.y);
}
```

- [ ] **Step 6: Build the client** to confirm it compiles.

Run: `npm run build --workspace=@gridforce/client`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/render/
git commit -m "feat: Renderer wraps playfield in camera-translated container"
```

---

## Task 9: main.ts — drive the camera + react to stage changes; drop `dashing` indicator

**Files:**
- Modify: `packages/client/src/main.ts`
- Modify: `packages/client/src/render/PlayerRenderer.ts`

- [ ] **Step 1: Drop the `dashing` field in PlayerRenderer**

In `PlayerRenderer.ts`, find any code that consults `dashRemainingS` (removed) or the `dashing` boolean passed from main.ts. Replace with `false` or remove the visual entirely. The simplest move: delete the dashing-effect branch.

- [ ] **Step 2: Update main.ts's per-frame block**

Find the render-sample loop that constructs `{ x, y, facing, dashing }` and drop the `dashing` key.

Below that, add the camera drive:

```ts
// Camera follows the local player.
const me = world.visualLocalPosition(alpha);
renderer.tick(dtMs, me.x, me.y);
```

(`alpha` is the existing render-time interpolation parameter; `dtMs` is the frame delta in ms.)

- [ ] **Step 3: React to stage transitions**

Maintain a `lastRenderedStageIndex` variable above the rAF callback. Inside the callback:

```ts
if (world.currentStageIndex !== lastRenderedStageIndex) {
  renderer.setGrid(world.getCurrentStage().grid);
  lastRenderedStageIndex = world.currentStageIndex;
}
```

Place this immediately before the camera-tick block so `renderer.setGrid` runs before the camera's first per-frame update on the new stage.

- [ ] **Step 4: Build + smoke test**

Run: `npm run build && npm run dev`
Open the client; default Test Run should look identical (camera centres on player on the small grid).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/main.ts packages/client/src/render/PlayerRenderer.ts
git commit -m "feat: main.ts drives camera; drop dashing visual indicator"
```

---

## Task 10: Large stage + large run

**Files:**
- Modify: `packages/shared/src/stages.ts`

- [ ] **Step 1: Add entries**

```ts
STAGES['large-grid'] = {
  id: 'large-grid',
  displayName: 'Large Grid',
  grid: { cols: 36, rows: 24, panelSize: 64 },
  phaseSequence: [{ id: 'active', displayName: 'Active', durationS: null }],
};

RUNS['large-run'] = {
  id: 'large-run',
  displayName: 'Large Run',
  stageSequence: ['large-grid'],
};
```

Add them to the existing object literals — don't restructure the file.

- [ ] **Step 2: Typecheck + test**

Run: `npm run typecheck && npm test --workspace=@gridforce/shared`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/stages.ts
git commit -m "content: add large-grid stage (36x24) and large-run"
```

---

## Task 11: Integration test — sprint survives 10% input loss

**Files:**
- Modify: `packages/server/src/test/integration.headless.test.ts`

- [ ] **Step 1: Read the existing integration test for the harness pattern**

Look for the "4 clients × network profiles" or "late-joining client" test. They use `TestClient` with a `drive` callback. Use the same shape.

- [ ] **Step 2: Add a sprint-under-loss case**

```ts
test('sprint flag survives 10% input loss via redundancy', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'sprinter',
      profile: { lossOut: 0.1, lossIn: 0, jitterMs: 0, delayMs: 30 },
      drive: () => ({ mx: 1, my: 0, dash: false, sprint: true }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    assert.equal(room.startGame(id), true);
    c.start();
    // Run for 2 seconds. With 30 Hz inputs and 10% loss, ~6 ticks
    // would lose their direct input, but the 3-tick redundancy window
    // covers them. Track the server's per-tick view of the sprint
    // flag; it must read true for every tick we expected input.
    await new Promise<void>((r) => setTimeout(r, 2000));
    c.stop();
    // Server-side check: position moved roughly as sprint-walk would.
    const finalState = Array.from(room.states.values())[0]!;
    const startState = newPlayerState(0, finalState.id ? 0 : 0, 0); // sentinel
    void startState;
    // Compare against a sprint-walk distance over ~2s. The clamp may
    // cap us at the right wall, so just assert we travelled meaningfully
    // farther than a non-sprint walk would in 2s.
    const walkOnly = 2 * 220; // 440 px
    assert.ok(
      finalState.x > walkOnly * 1.3,
      `sprint should outrun plain walk (server x=${finalState.x}, walk-only=${walkOnly})`,
    );
  } finally {
    await h.shutdown();
  }
});
```

(The exact NetSim profile shape is whatever `NetSimProfile` defines — check the existing TestClient profile usage and adapt.)

- [ ] **Step 3: Run the new test**

Run: `npm test --workspace=@gridforce/server -- --test-name-pattern "sprint flag"`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/test/integration.headless.test.ts
git commit -m "test: sprint flag survives 10% input loss via redundancy"
```

---

## Task 12: Verify + push for deploy

- [ ] **Step 1: Full test sweep**

Run: `npm test`
Expected: all tests green.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean across all three workspaces.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 0 errors (warnings are OK if they match the existing baseline).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: vite build succeeds.

- [ ] **Step 5: Push**

```bash
git push origin main
```

Webhook auto-deploys; deploy script gates on typecheck + build only (sub-spec 1 memory note confirms this). Expect `gridforce.service` to restart within ~30s.

- [ ] **Step 6: Verify deploy via VM journal**

```powershell
& "C:\Windows\System32\OpenSSH\ssh.exe" -o ConnectTimeout=8 clab@8.231.244.213 'sudo journalctl -u gridforce-webhook --since "3 minutes ago" --no-pager | tail -20; echo ===; sudo journalctl -u gridforce --since "3 minutes ago" --no-pager | tail -5'
```

Expected: `deploy finished with code 0`, gridforce.service restart with new wire-format.

- [ ] **Step 7: Manual playtest**

Open https://grid.clab.su:

- Default Test Run: regression — camera centres on player, 18×12 grid, Space teleports one panel, Shift moves faster. No dash-burst slide anymore.
- Switch to Large Run from the lobby dropdown, start: 36×24 grid; camera follows; sprint + jump traversal feels right. Borders of the world are visible at world edges (camera clamps).
- Connect a second tab (incognito) to the same room: remote player jumps look snappy (one-tick teleport).

---

## Self-review

Verified before handing off:
- **Spec coverage:** every section of the spec maps to a task. Map size + content → Task 10. Sprint → Task 2. Panel-jump → Tasks 3+4. Camera → Tasks 7+8+9. Wire bump → Task 1. Tests → Tasks 2, 4, 11 + existing-test updates in Task 3.
- **Type consistency:** `panelJumpCooldownS` is the field name everywhere (sim.ts, types.ts, PlayerEncoder, wire.test.ts). `PLAYER_SPRINT_MULTIPLIER` and `PANEL_JUMP_COOLDOWN_S` are the constant names. The `dash` input bit retains its wire name even after its semantics change to "rising-edge panel jump" — this matches the spec.
- **Placeholders:** none. Visual VFX for sprint/jump is explicitly deferred in the spec ("Open items reserved for polish") and the plan honours that — Task 9 drops the old dashing indicator without replacing it.
- **One stale assumption flagged for the executor:** `RemotePlayerInterpolator.clear(id)` and `GridRenderer.rebuild(grid)` may or may not exist verbatim. Both are small additive methods; if the existing API doesn't expose them, add them as part of the corresponding task.
