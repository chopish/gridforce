# Larger maps, hold-shift sprint, and Space → panel-jump

## Context

Gridforce just shipped the Run → Stage → Phase framework (sub-spec 1, commit `81ec98e`). The framework is live but the only stage in the registry is `test-grid` (18×12 panels) and movement is still a smooth Space-dash with no modifier-key handling. This spec is **sub-spec 2** of the three-part sequence the user laid out: bigger play area, a held-shift sprint, and repurposing Space as a discrete panel-jump per the original GridForce design doc.

The three changes are deliberately bundled because they share the same surface (PlayerInput wire format, `stepPlayer` simulation, renderer/camera) and gate the same playtest milestone: "run around a real-sized arena, sprint between hotspots, panel-jump to reposition." Together they take the prototype from "movement testbed" to "an arena you'd actually want to fight on."

Sub-spec 3 (electrical-defense gameplay — panel state, enemies, shock, repair) will land on top of this.

## Goals and non-goals

**Goals:**

- A second stage with a meaningfully larger grid that the host can pick from the lobby.
- Per-player camera that smoothly follows the local player so the larger grid stays readable at any viewport size.
- Hold-shift sprint as a flat ~1.6× walk-speed multiplier.
- Space becomes a discrete one-panel teleport (with cooldown) in the direction the player is moving / facing.
- Wire format bumped to v11; clean break, no compat shims (still pre-production).

**Non-goals:**

- AOI / view-distance culling. The new grid is large enough to be interesting but small enough that broadcasting the whole world is still cheap (~12 KB/s/client for the empty grid; same as today).
- Multi-stage runs that mix grid sizes mid-run. The framework supports it (StageDef.grid is per-stage) and the renderer will react to stage transitions via snapshot-driven reinit, but the bootstrap content only adds single-stage runs.
- Stamina / sprint cost / sprint cooldown. Sprint is free for now.
- Panel-jump landing rules tied to panel state (BROKEN panels blocking). Sub-spec 3 owns panel state; this spec lands a jump that clamps to grid bounds and nothing else.
- A polished "snap" VFX on panel-jump. Reserve as a polish task — the spec only ensures the simulated position and render position agree on tick boundaries.

## Design

### Map size and new content

No change to `GRID_COLS` / `GRID_ROWS` defaults in `constants.ts`. The 18×12 default still applies to `createDefaultGrid()` so any code that calls it without going through a Stage gets the small grid.

`shared/src/stages.ts` gains:

```ts
STAGES['large-grid'] = {
  id: 'large-grid',
  displayName: 'Large Grid',
  grid: { cols: 36, rows: 24, panelSize: 64 }, // 2304 × 1536
  phaseSequence: [{ id: 'active', displayName: 'Active', durationS: null }],
};

RUNS['large-run'] = {
  id: 'large-run',
  displayName: 'Large Run',
  stageSequence: ['large-grid'],
};
```

The lobby's run dropdown surfaces both `Test Run` (regression baseline) and `Large Run` (playtest target).

### Sprint

New `sprint: bool` field on `PlayerInput`. Encoded as one bit alongside the existing `dash` bit in the flag byte the encoder already reserves — zero new bytes on the wire.

`InputCapture` tracks `ShiftLeft` / `ShiftRight` as a held boolean and emits it in the per-tick input. Gamepad: bind `buttons[6]` (left trigger on a standard XInput layout) to sprint — physically distinct from the existing dash buttons (`0` and `7`) so a player can sprint and jump independently.

`stepPlayer` (in `shared/src/sim.ts`) reads `input.sprint` and, while true, scales the walk-vector magnitude by `PLAYER_SPRINT_MULTIPLIER = 1.6` before clamp + integrate. Sprint applies only to walk; the panel-jump is instantaneous so sprint never compounds with it. Sprint is deterministic and reconciliation-safe.

### Panel-jump

The existing `dash` bit on the wire keeps its name (it's a generic "trigger" bit) but its semantics change. When `input.dash === true` AND `state.panelJumpCooldownS === 0`:

1. Resolve direction: if `hypot(mx, my) > 0.1`, use `(mx, my)`; otherwise use `(cos(facing), sin(facing))`. Snap to one of 8 octants:
   - `dx ∈ {-1, 0, +1}`, `dy ∈ {-1, 0, +1}`, not both zero.
2. Compute target = `position + (dx * panelSize, dy * panelSize)`.
3. Clamp target to `[radius, worldWidth - radius] × [radius, worldHeight - radius]`. A jump into a wall lands at the wall, not no-op.
4. Set `position = target` atomically on this tick. No interpolation — single-tick teleport.
5. Set `state.panelJumpCooldownS = PANEL_JUMP_COOLDOWN_S`.

If `input.dash === true` but cooldown > 0, the bit is silently ignored — same gate as the old smooth dash. Holding `dash` rather than tapping it doesn't matter: once cooldown reaches 0 the next tick with the bit set fires another jump.

`PANEL_JUMP_COOLDOWN_S = 0.4`. Stored in `PlayerState.panelJumpCooldownS` (renamed from `dashCooldownS`). The existing `dashRemainingS` field is dropped entirely — there's no "during" interval for an instantaneous action.

The PlayerEncoder loses one quantized u8 (`dashRemainingS`) and renames another (`dashCooldownS` → `panelJumpCooldownS`). Net wire change per player per snapshot: −1 byte.

**Visual snap.** `PredictedWorld.step` already snapshots `prevPlayers` for render-time interpolation. On the tick a panel-jump fires (we know because `nextLocal.position` differs from `localState.position` by more than walk-speed × dt), set `prevPlayers[localId] = { ...nextLocal }` before storing `nextLocal`. The lerp `prev → cur` then resolves to the destination for any alpha, giving a hard visual snap that matches the simulation. Remote players' visuals come from `RemotePlayerInterpolator` which buffers snapshots; a one-tick delta-larger-than-walk-speed there triggers the same snap branch.

### Camera follow

New `client/src/render/Camera.ts`. Owns a current world-position and a target world-position. Each frame:

- target = local player's visual position from `PredictedWorld.visualLocalPosition(alpha)`
- current = `current.lerp(target, 1 - exp(-dtSeconds / CAMERA_TIME_CONSTANT_S))` (frame-rate-independent exponential smoothing; constant ~0.12s)
- Clamp current.x to `[viewportW/2, worldW − viewportW/2]` (likewise y). When the viewport is larger than the world in some axis, snap that axis to world-center so the playfield stays on screen instead of revealing void.
- Emit a translation transform into the playfield container (the existing `Renderer` already wraps grid + players + npcs in a container; the camera translates that container by `-current + viewport/2`).

`Renderer` gains a `setGrid(grid: GridDef)` method that rebuilds the `GridRenderer` and updates the camera's world bounds. `PredictedWorld` exposes a `getCurrentStage()` helper (already shipped in sub-spec 1); `main.ts`'s `onFrame` calls `renderer.setGrid(world.getCurrentStage().grid)` when `world.currentStageIndex` changes from the previously-rendered value. Mid-run stage swaps now work end-to-end.

Existing `GridRenderer`'s 64×64 panel sprites are re-used as-is — same texture, just more instances.

### Wire format and schema bump

Bump `SCHEMA_VERSION` 10 → 11. Add a `v11` line to the history comment in `constants.ts`:

```
//  v11: PlayerInput gains a `sprint` bit (held shift). PlayerEncoder
//       drops dashRemainingS (panel-jump is instantaneous) and renames
//       dashCooldownS → panelJumpCooldownS. The `dash` input bit is
//       still wire-named `dash` but now means "rising-edge panel jump".
```

PlayerInput encoder/decoder update: the existing flag byte has bits 0–3 used (or similar); allocate the next free bit for `sprint`. Confirm the slot by reading `shared/src/net/messages/Input.ts` during implementation.

### Tests

**`shared/src/sim.test.ts`** (extend existing file)

- `sprint produces 1.6× distance over N ticks`: with `sprint=true`, walk for 30 ticks straight, assert position delta ≈ `30 × PLAYER_MOVE_SPEED × 1.6 × SERVER_TICK_DT_S` within rounding.
- `sprint while panel-jumping does not stack on the jump`: rising-edge dash + sprint on the same tick → position delta equals exactly one panelSize in the chosen octant, not `panelSize + sprint*walk`.
- `panel-jump lands on panel center in the input direction`: input vector `(1, 0)`, dash rising-edge → x increases by `panelSize`, y unchanged.
- `panel-jump from idle uses facing`: zero input, facing set to π/2, dash rising-edge → y increases by `panelSize`.
- `panel-jump truncates at world edge`: position one panel from the right wall, jump right → x = `worldWidth - radius` exactly.
- `panel-jump cooldown enforced`: dash, then dash again 0.2s later → second jump is a no-op, position unchanged.
- `replay determinism stays correct`: same input sequence including sprint + panel-jump replays to identical state.

**`shared/src/net/__tests__/wire.test.ts`**

- `Input round-trip preserves sprint bit`: encode a list of 3 inputs with mixed sprint values, decode, assert.
- `PlayerEncoder round-trip with panelJumpCooldownS`: mid-cooldown player state encodes/decodes within u8 quantization slop.
- The existing Snapshot "mid-dash player" case becomes a "mid-cooldown player" case — asserts only `panelJumpCooldownS`. The corresponding `dashRemainingS` assertion is removed (field no longer exists).

**`server/src/test/integration.headless.test.ts`** (extend the existing late-joining/4-client test or add one focused case)

- `sprint flag survives input redundancy under 10% loss`: drive with sprint held continuously, assert that no tick on the server sees `sprint=false` (which would imply the redundancy buffer dropped it).

**Manual playtest:**

- Host `Large Run` from the lobby. Confirm:
  - Camera follows the local player; the world scrolls.
  - Holding Shift moves noticeably faster (~1.6×).
  - Tapping Space teleports one panel in the direction of travel; tapping while idle teleports in the last-facing direction.
  - Spamming Space respects the 0.4s cooldown.
  - With a second client connected, the remote player's panel-jumps look snappy (one-tick snap) rather than a slide.
  - Switch back to `Test Run` from the lobby (pre-game): camera centers, grid is 18×12, behaviour identical to today.

## Open items reserved for polish / follow-up

- Sprint VFX (engine glow? motion blur?). The HUD's existing `dashing` indicator goes away with `dashRemainingS`; a small "sprinting" pill would be a low-cost replacement.
- Panel-jump landing VFX (electric snap?). Reserved for a polish pass.
- Per-stage panelSize variation. The data model supports it; first content using it lands when sub-spec 3 (the upper-dome tier with smaller cells, per the design doc) starts.
- AOI culling. When the entity count grows past ~500 per snapshot, revisit.

## Files touched

| Path | Change |
|---|---|
| `shared/src/stages.ts` | add `STAGES['large-grid']` + `RUNS['large-run']` |
| `shared/src/constants.ts` | `SCHEMA_VERSION = 11`; v11 changelog; new `PLAYER_SPRINT_MULTIPLIER = 1.6` and `PANEL_JUMP_COOLDOWN_S = 0.4` |
| `shared/src/types.ts` | `PlayerInput` adds `sprint: boolean`; `PlayerState` renames `dashCooldownS` → `panelJumpCooldownS` and drops `dashRemainingS` |
| `shared/src/sim.ts` | sprint multiplier; panel-jump replaces smooth dash |
| `shared/src/net/entities/PlayerEncoder.ts` | rename + remove quantized cooldown field |
| `shared/src/net/messages/Input.ts` | sprint bit in flag byte |
| `shared/src/sim.test.ts` | new test cases (see Tests section) |
| `shared/src/net/__tests__/wire.test.ts` | sprint + cooldown rename round-trips |
| `client/src/input/InputCapture.ts` | track ShiftLeft/ShiftRight; emit sprint |
| `client/src/sim/PredictedWorld.ts` | drop `dashRemainingS` reads; jump visual snap (set prev = next when delta > walk-step) |
| `client/src/sim/RemotePlayerInterpolator.ts` | same snap branch for remote players |
| `client/src/render/Camera.ts` | **NEW** — per-player camera follow with smoothing + clamp |
| `client/src/render/Renderer.ts` | wire Camera into the playfield container; expose `setGrid(grid)` for mid-run stage swaps |
| `client/src/render/PlayerRenderer.ts` | drop the `dashing` visual state (or replace with a one-shot snap pulse — polish) |
| `client/src/main.ts` | call `renderer.setGrid()` when `world.currentStageIndex` changes |
| `server/src/test/integration.headless.test.ts` | sprint-under-loss case |

## Verification (post-implementation)

1. `npm run typecheck` clean across all packages.
2. `npm test` — all existing tests pass + the new cases.
3. `npm run lint` — 0 errors.
4. Manual playtest checklist above.
5. Push to main; webhook auto-deploy (now wired correctly post-rotation) lands the change on https://grid.clab.su.
