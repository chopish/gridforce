# Electrical-defense: first playable round

## Context

Sub-spec 2 (larger maps + sprint + panel-jump) shipped at commit `03e41f8` and is live at https://grid.clab.su. Players can run, sprint, and panel-jump on the Large Run arena, but there is still no gameplay — no enemies, no panel state, no combat, no objective. This spec lands the **first complete playable round**: a single survival session where players defend solar panels against waves of mutated wildlife (Crawlers), repair damage with carbon dropped by kills, and either survive 5 waves or lose to city HP draining / all players going down.

The design draws directly from the original GridForce design doc (`Downloads/GridForce.txt`) — Smash TV horde defense, electrical shock attacks, panel state degradation, carbon scavenging, co-op stakes. Tools beyond the local shock (electrodes, discharge, magnet, etc.) are deferred to future specs; this one ships the minimum-but-complete loop.

## Goals and non-goals

**Goals**
- A complete playable survival round: spawn, fight, repair, win or lose.
- Three-state panels (LIVE / DAMAGED / BROKEN) as both the conductive grid and the defensive surface.
- Crawler enemies with deterministic AI: spawn at edge → walk to nearest panel → attack → walk through holes → exit and damage the city.
- Local shock attack as the core verb.
- Carbon econ closing the loop between killing and repairing.
- Hold-to-repair as a real game-feel beat.
- Player HP with downed/revive states for co-op stakes.
- Wave structure with escalating budgets, looped via a new `loopPhases` field on `StageDef`.
- City HP as the global loss timer.
- Win state on surviving wave 5.
- Schema bumped to v12; clean break, no compat shims.

**Non-goals**
- Electrodes (3e), discharge (3f), push/pull (3g), bright panel / walls / reinforce (3h) — all deferred.
- More than one enemy type. Chargers, spitters, bosses come in 3i.
- Tool-unlock progression / persistence (3j).
- Multiple stages with mixed grid sizes mid-run.
- AI partner gameplay (the design-doc "tag" mechanism for cooperating with AI on electrodes is deferred to 3e).
- AOI culling. Wave budgets keep entity counts well under the existing snapshot envelope.
- Aesthetic polish (sirens, screen shake, particle effects beyond minimum). The systems must work; polish is its own spec.

## Design

### Panel state machine

Each grid cell holds one of:

- `LIVE` — bright, full power, conducts electricity, blocks enemy passage.
- `DAMAGED` — cracked, no conduction, still blocks enemy passage.
- `BROKEN` — pit/hole, no conduction, **passable by enemies**; permanent (per the doc).

Transitions:
- LIVE → DAMAGED: Crawler attacks for `PANEL_ATTACK_TO_DAMAGE_S = 0.5` seconds.
- DAMAGED → BROKEN: Crawler attacks for another `PANEL_ATTACK_TO_BREAK_S = 0.5` seconds.
- DAMAGED → LIVE: a player completes a hold-repair (see Repair section). Costs 1 carbon.
- BROKEN → (anything): impossible.

**State storage:** server-side `panelStates: Uint8Array` of length `cols * rows`, indexed by `y * cols + x`. Values are `PanelState` enum members. New player join sees the current state in `Welcome`; in-progress changes broadcast in snapshots.

**Wire encoding:** snapshots carry a delta-encoded run of `(index: varuint, newState: u8)` pairs for any cells that changed since the last full sync. Welcome includes the full state as a RLE-compressed `Uint8Array` (length-prefix + byte stream — most rounds will be mostly LIVE, so RLE is cheap). For the first-playable build this can ship as **full state in every snapshot** (RLE-encoded, ~few hundred bytes/snap at 36×24) — deltas are a follow-up optimization once profiling shows it matters.

Concretely for this spec: send the full panel-state array in every snapshot, RLE-encoded. Server keeps a `Uint8Array(cols*rows)`. Encoder walks the array, emits `(state: u8, runLength: varuint)` pairs. Decoder reconstructs. At 36×24 with most cells LIVE: ~3–6 byte RLE → ~120 B/s at 20 Hz. Acceptable.

**Render:** `GridRenderer` extends to draw per-cell state. LIVE is the existing solar-panel tile sprite; DAMAGED overlays a crack pattern + dim alpha 0.6; BROKEN replaces the tile with a darker pit sprite (or just renders nothing for the tile and lets a global "void" background show through).

### Crawler enemy

New entity type alongside Player/NPC. **Crawlers and the existing wandering NPCs are different things** — NPCs are stress-test bouncing walkers, Crawlers are gameplay. Crawlers get their own entity type (`EntityType.Crawler = 3`) in the wire format.

**State per Crawler:**
```ts
interface CrawlerState {
  id: number;          // u16
  x: number;           // f32 px world position
  y: number;           // f32
  facing: number;      // f32 (quantized u8 on wire)
  hp: number;          // u8, default 1 (one-shot from local shock)
  target: {            // current target panel coords (for AI debug + interpolation hints)
    cx: number;        // u8 column
    cy: number;        // u8 row
  };
  state: CrawlerState_AIState;  // u8 enum: APPROACHING | ATTACKING | TRANSITING
}
```

**AI states:**
- `APPROACHING`: walking toward the target panel at `CRAWLER_MOVE_SPEED = 80 px/s`. Once within `PLAYER_RADIUS + tile-half`, transition to ATTACKING.
- `ATTACKING`: pinned in place adjacent to a LIVE or DAMAGED panel; advances the panel's "damage timer". When the panel breaks, transition to TRANSITING.
- `TRANSITING`: walking through the BROKEN tile and toward the opposite edge. When the Crawler's centre passes the edge of the world: deduct 1 from `cityHp`, remove the Crawler.

**Targeting:**
- On spawn: pick a random edge, pick a random tile on that edge, walk toward it.
- After damaging that tile to BROKEN: target the world centre line for the TRANSITING phase. Just keeps walking forward through the hole; the exit determines the city-damage event.
- A Crawler whose ATTACKING target is on the OPPOSITE side of an already-BROKEN tile prefers walking through the hole over creating a new one (so multiple Crawlers funnel through openings rather than spreading damage).

**Damage to players:**
- If a Crawler's centre is within `(PLAYER_RADIUS + CRAWLER_RADIUS)` of a non-downed player: deal `CRAWLER_CONTACT_DPS = 30` HP/s to that player.
- A downed player is invisible to Crawlers' damage (they walk over without harming further).

**Spawn rate (controlled by the Wave Manager — see below):**
- Server-side spawner picks a random edge tile each spawn event.
- Hardcoded for first playable: each wave's enemies spawn evenly distributed over the first ~half of the wave's duration, capped at `MAX_ALIVE_CRAWLERS = 24` simultaneous.

### Wave Manager + `loopPhases` extension

Extend `StageDef`:

```ts
export interface StageDef {
  id: string;
  displayName: string;
  grid: GridDef;
  phaseSequence: PhaseDef[];
  loopPhases?: boolean;  // NEW. If true, wrap to phaseSequence[0] when the
                         // last phase ends instead of advancing to the next
                         // stage. Useful for "wave 1, wave 2, …" loops.
  theme?: string;
}
```

In `Room.advancePhase()`, when `currentPhaseIndex` exceeds the stage's phase sequence:
- If `stage.loopPhases === true`: wrap to phase 0, increment `currentWave` (new room state, u8, starts at 1).
- Else: existing behavior — call `advanceStage()`.

New stage definition:

```ts
STAGES['td-prototype'] = {
  id: 'td-prototype',
  displayName: 'TD Prototype',
  grid: { cols: 36, rows: 24, panelSize: 64 },
  phaseSequence: [
    { id: 'prepare',  displayName: 'Prepare',  durationS: 10 },
    { id: 'wave',     displayName: 'Wave',     durationS: null },  // event-driven
    { id: 'cleanup',  displayName: 'Cleanup',  durationS: 5 },
  ],
  loopPhases: true,
};

RUNS['td-prototype'] = {
  id: 'td-prototype',
  displayName: 'TD Prototype',
  stageSequence: ['td-prototype'],
};
```

**Wave Manager (server-side, owned by `Room`):**
- `currentWave: number` (u8, 1-indexed). Resets to 1 in `startGame`.
- `waveSpawnBudget(wave: number): number` returns enemies-this-wave. Curve: `4 + 4 * wave` → wave 1 = 8, wave 2 = 12, … wave 5 = 24.
- During `prepare` phase: no spawns, players can run + repair.
- On entry to `wave` phase: reset `waveKills = 0`, `waveSpawned = 0`. Start spawning.
- During `wave` phase: spawn up to `waveSpawnBudget(currentWave)` enemies over the first `WAVE_SPAWN_WINDOW_S = 20` seconds, paced evenly with jitter, capped at `MAX_ALIVE_CRAWLERS` alive at once. When `waveKills === waveSpawnBudget` (every Crawler from this wave has died, regardless of whether they reached the city), call `room.advancePhase()` to enter cleanup.
- Crawlers that exit through holes also count as "ended" (they decremented city HP, then died). Treat them the same as killed Crawlers for the kill counter.
- On entry to `cleanup` phase: idle 5s, players collect remaining carbon, breathe.
- On exit from `cleanup`: framework auto-advances; with `loopPhases: true` this wraps to `prepare` and increments `currentWave`.
- When `currentWave` would exceed `WAVE_GOAL = 5` after a successful cleanup: don't loop — advance past the stage to hit `run-end`.

**Implementation:** in `advancePhase()`, when the current index is the last phase AND `loopPhases` is true, check `currentWave + 1 > WAVE_GOAL`. If yes, fall through to `advanceStage()` instead of wrapping; since the `td-prototype` run has a single-element `stageSequence`, this transitions the room to `'run-end'`. If no, wrap to phase 0 and increment `currentWave`. This keeps Run/Stage/Phase semantics intact: hitting the wave goal = stage complete = run-end.

### Combat — local shock

**New `shock: bool` bit in `PlayerInput`:**
- Bit 2 in the existing buttons byte (dash=bit0, sprint=bit1, shock=bit2).
- Wire layout otherwise unchanged.
- Client: bound to `KeyF` and the left mouse button (`mousedown` on the playfield canvas — rising-edge), plus gamepad `buttons[2]` (X on Xbox). Held = continuous fire (server enforces cooldown).

**Server behavior in `physicsStep` during `wave` phase:**
- For each player whose input has `shock === true` AND `shockCooldownS === 0`:
  - Determine the player's own panel cell: `cx = floor(x / panelSize), cy = floor(y / panelSize)`.
  - Iterate the 4 cardinal neighbors `(cx±1, cy)` and `(cx, cy±1)`.
  - For each neighbor that is `LIVE`: any Crawler whose centre is inside that neighbor's tile bounds takes 1 damage (Crawlers are 1-HP, so they die).
  - Set `shockCooldownS = SHOCK_COOLDOWN_S = 0.25` on the player.
- Decrement `shockCooldownS` toward 0 every tick.

**Player state additions (wire format):**
- `shockCooldownS: f32` (or quantized u8).

**Client visual (deferred polish, minimum for first playable):**
- On shock fire: brief flash on the player's tile + each LIVE neighbor (1 frame of full-brightness overlay). A future polish pass adds the forked-arc particle.

### Carbon — drops and pickups

**New entity type `Carbon` (EntityType = 4):**
```ts
interface CarbonState {
  id: number;     // u16
  x: number;      // f32
  y: number;      // f32
  ttlS: number;   // f32 — countdown to despawn, default 10s
}
```

**Server:**
- On Crawler death (from shock): spawn one Carbon at the Crawler's centre.
- Each tick during `wave` and `cleanup` phases: decrement every Carbon's `ttlS` by `dt`. If ≤ 0, remove.
- Each tick: for every player and every Carbon, check distance. If within `(PLAYER_RADIUS + CARBON_PICKUP_RADIUS)` (`CARBON_PICKUP_RADIUS = 16`): increment that player's `carbon` (clamped to 99), remove the Carbon.

**Player state additions:**
- `carbon: number` (u8 quantized, 0–99).

### Repair

**New `repair: bool` bit in `PlayerInput`:**
- Bit 3 in the buttons byte (dash=0, sprint=1, shock=2, repair=3).
- Client: bound to `KeyR` and right mouse button, plus gamepad `buttons[3]` (Y on Xbox). Held = repair-in-progress.

**Player state additions:**
- `repairProgressS: f32` (or quantized u8). Visible to remote clients via PlayerEncoder.

**Server behavior in `physicsStep`:**
- For each player with `repair === true`:
  - Determine the player's current tile.
  - If that tile is `DAMAGED` AND `carbon ≥ 1`:
    - Increment `repairProgressS` by `dt`.
    - If `repairProgressS >= REPAIR_DURATION_S = 1.5`:
      - Set the tile to `LIVE`.
      - Deduct 1 carbon.
      - Reset `repairProgressS = 0`.
  - Else: reset `repairProgressS = 0`.
- For each player with `repair === false`: reset `repairProgressS = 0`.

Result: holding R/RMB while standing on a damaged tile with at least 1 carbon drains a 1.5s timer; leaving the tile, releasing the input, or running out of carbon resets it. A Crawler hitting the player mid-repair doesn't directly cancel the repair, but the player's HP drains and they'll either move (resetting) or die (downed players can't hold inputs anyway).

### Player HP + revives

**Player state additions:**
- `hp: number` (u8, 0–100; spawn at 100).
- `downed: boolean` (bit on the flags byte).
- `reviveProgressS: f32` (or quantized u8) — accumulated time a teammate has been within revive range.

**Server behavior:**
- Each tick: for each non-downed player, check distance to every Crawler. For each Crawler within contact range: drain `CRAWLER_CONTACT_DPS * dt` from the player's HP.
- When a player's HP reaches 0: set `downed = true`, `hp = 0`. Zero out their movement input on the next tick (they can't walk, sprint, shock, jump, or repair while downed).
- Each tick: for each downed player, check distance to every non-downed teammate. If **at least one** teammate is within `REVIVE_RANGE = panelSize * 1.5` (1.5 tiles, ~96 px): increment `reviveProgressS` by `dt`. Multiple teammates in range do not speed up the revive — the timer accumulates at a fixed rate so long as someone is there.
- If `reviveProgressS >= REVIVE_DURATION_S = 3.0`: set `downed = false`, `hp = REVIVE_HP = 50`, `reviveProgressS = 0`.
- If at any tick no teammate is in range: reset `reviveProgressS = 0`.

**Client:**
- Downed players render as a slumped sprite with a faint timer ring.
- Standing within revive range shows a held-progress indicator over the downed teammate.
- The local downed player sees a "DOWNED — waiting for revive" overlay.

**Loss condition (player side):**
- If every player in the room is `downed` simultaneously: `room.phase = 'run-end'` with a "WIPE" subtype flag. (For wire format simplicity, repurpose the existing `run-end` phase value; the win/loss differentiation rides on `cityHp > 0` and at-least-one-player-not-downed at the moment of transition. Client computes the headline from those.)

### City HP + win/loss state

**Room state additions:**
- `cityHp: number` (u8, 0–100). Resets to 100 in `startGame`.

**Behavior:**
- When a Crawler exits through a BROKEN tile: deduct 1 from `cityHp`.
- If `cityHp` reaches 0: `room.phase = 'run-end'`.

**Win condition:**
- Surviving wave 5's cleanup phase. The framework's stage-advance fires at that point (since `td-prototype` has only one stage in its `stageSequence`), transitioning to `run-end`.

**Client run-end panel** (extends the existing StageHud "Run Complete" panel):
- Compute headline from the last-known snapshot at transition:
  - All players downed: "OVERRUN — your team fell to the wildlife".
  - cityHp = 0: "CITY LOST — too many got through".
  - currentWave > 5: "VICTORY — you survived 5 waves".
- Show stats: waves cleared, kills, panels lost-permanently, carbon spent on repairs.

These per-room counters are useful for the run-end panel but cheap to track:
- `totalKills: u16` (clamps at 0xffff, fine)
- `panelsBroken: u8`
- `carbonSpent: u16`

### Wire format — schema v12

Schema bumped 11 → 12. v12 changelog:

```
//  v12: First-playable gameplay. PlayerInput adds `shock` + `repair`
//       bits. PlayerState adds hp/downed/carbon/repairProgressS/
//       reviveProgressS/shockCooldownS. Snapshot adds panel-state RLE
//       block, Crawler entity group, Carbon entity group, cityHp,
//       currentWave, and per-room counters (totalKills, panelsBroken,
//       carbonSpent). Welcome adds full panel-state Uint8Array.
//       New EntityTypes: Crawler=3, Carbon=4.
```

**Snapshot layout addition (after the existing fields, before the entity groups):**
```
u8       cityHp
u8       currentWave
u16      totalKills
u8       panelsBroken
u16      carbonSpent
varuint  panelRleLen
[u8 state, varuint runLen] × panelRleLen   // RLE of panel states
```

**Welcome layout addition (after maxPlayers/sessionKey, before players):**
```
varuint  panelStateBytes
u8 × panelStateBytes                          // full Uint8Array, raw (not RLE — joiner-friendly)
```

**Entity types:**
- Snapshot now potentially emits up to 4 entity groups: Player, NPC, Crawler, Carbon. The existing dynamic-count field handles this.

**PlayerEncoder additions:**
- `hp: u8` (0–100)
- `downed: bool` (existing flags byte, allocate bit 2)
- `carbon: u8` (0–99 quantized)
- `repairProgressS: u8` (quantized 0–1.5s)
- `reviveProgressS: u8` (quantized 0–3.0s)
- `shockCooldownS: u8` (reuse the existing `quantizeTimer` with `TIMER_SCALE = 255`. 0–0.25s maps to 0–~64; ~4 ms resolution, plenty for a 30 Hz tick game)

Approximate per-player wire growth: ~6 bytes. At 4 players × 20Hz = ~480 B/s. Fine.

### Tests

**Shared sim tests** (`sim.test.ts` + new `panels.test.ts` + new `crawler.test.ts`):
- `local shock kills crawler on adjacent LIVE tile`
- `local shock does NOT reach across DAMAGED tile (no conduction)`
- `local shock does NOT reach diagonals (4 cardinal only)`
- `shock cooldown enforced (second fire 0.1s after first is no-op)`
- `crawler attacking a LIVE tile transitions it to DAMAGED in 0.5s`
- `crawler attacking a DAMAGED tile transitions it to BROKEN in 0.5s`
- `crawler walks through a BROKEN tile in TRANSITING state`
- `crawler exit decrements cityHp by 1`
- `carbon pickup on overlap adds 1 to player carbon and removes the pickup`
- `carbon pickup expires after ttlS reaches 0`
- `hold-repair on DAMAGED tile flips to LIVE in 1.5s and deducts 1 carbon`
- `repair aborts on releasing the bit`
- `repair aborts on leaving the tile`
- `repair does nothing on a LIVE tile`
- `repair does nothing with 0 carbon`
- `crawler contact drains player HP at CRAWLER_CONTACT_DPS`
- `player at hp=0 becomes downed`
- `downed player within revive range for 3s is revived at HP 50`
- `revive aborts when teammate leaves range`

**Wire tests** (`wire.test.ts`):
- `shock + repair bits round-trip in Input message`
- `PlayerState round-trip carries hp/downed/carbon/repairProgressS/reviveProgressS`
- `panel-state RLE round-trips for a fully-LIVE grid (compact)`
- `panel-state RLE round-trips for a mixed grid (runs of varying length)`
- `Crawler entity round-trip`
- `Carbon entity round-trip`
- `Welcome carries full panel-state byte array`

**Integration tests** (`integration.headless.test.ts`):
- `single wave clears: 8 crawlers spawn during wave, all die to shock, room advances to cleanup`
- `all players downed → run-end with WIPE headline`
- `cityHp reaches 0 → run-end with CITY LOST headline`
- `surviving 5 waves → run-end with VICTORY headline`

**Manual playtest:**
- Host TD Prototype run. Confirm: prepare phase shows 10s countdown; wave phase spawns enemies; shock kills them; carbon drops; repair restores damaged panels; HP drains on contact; downed → revivable; win at wave 5.
- Multi-client: a teammate revives a downed player; both shocks count toward the wave kill total.

## Files touched (approximate)

**Shared (new + modified):**
- `packages/shared/src/constants.ts` — schema bump, new gameplay constants
- `packages/shared/src/types.ts` — Input/Player/Snapshot/Welcome additions
- `packages/shared/src/stages.ts` — `loopPhases` on StageDef, `td-prototype` stage + run
- `packages/shared/src/sim.ts` — shock + repair handling in stepPlayer (or a new module)
- `packages/shared/src/panels.ts` — **NEW** — panel-state helpers + RLE codec
- `packages/shared/src/enemies/crawler.ts` — **NEW** — Crawler AI step function (deterministic)
- `packages/shared/src/net/messages/Input.ts` — shock + repair bits
- `packages/shared/src/net/messages/Snapshot.ts` — panel RLE, new entity groups, cityHp/wave/counters
- `packages/shared/src/net/messages/Welcome.ts` — full panel state
- `packages/shared/src/net/entities/PlayerEncoder.ts` — new player fields
- `packages/shared/src/net/entities/CrawlerEncoder.ts` — **NEW**
- `packages/shared/src/net/entities/CarbonEncoder.ts` — **NEW**
- `packages/shared/src/net/wire.ts` — EntityType enum gains Crawler=3, Carbon=4
- Tests: `panels.test.ts`, `crawler.test.ts`, additions to `sim.test.ts` + `wire.test.ts`

**Server:**
- `packages/server/src/Room.ts` — panel-state array, Crawler map, Carbon map, wave manager, cityHp + counters, run-end transitions, advancePhase override for loopPhases + wave goal
- `packages/server/src/CrawlerSpawner.ts` — **NEW** — picks edges + paces spawns
- `packages/server/src/test/td-prototype.test.ts` — **NEW** integration tests

**Client:**
- `packages/client/src/input/InputCapture.ts` — F/R keys + LMB/RMB + gamepad bindings
- `packages/client/src/sim/PredictedWorld.ts` — mirror new state (panels, cityHp, wave, counters)
- `packages/client/src/render/GridRenderer.ts` — three-state tile rendering
- `packages/client/src/render/CrawlerRenderer.ts` — **NEW**
- `packages/client/src/render/CarbonRenderer.ts` — **NEW**
- `packages/client/src/render/Renderer.ts` — wire new renderers into the playfield container
- `packages/client/src/ui/GameHud.ts` — **NEW** — HUD overlay showing cityHp / currentWave / player carbon / player HP
- `packages/client/src/ui/StageHud.ts` — extend run-end panel with win/loss headline + stats
- `packages/client/src/main.ts` — drive shock + repair through world.step + new HUD updates

Approximate file count: 18 modified + 9 new = ~27 files. This is materially larger than sub-spec 2 (16 files).

## Verification

1. `npm run typecheck` clean across all 3 workspaces.
2. `npm test` — all existing tests + the new ~25 cases pass.
3. `npm run lint` — 0 errors.
4. `npm run build` clean.
5. Manual playtest checklist above.
6. Push to main; webhook auto-deploys; gridforce.service restarts with the new wire format and panel-state visualizer; old client tabs SchemaMismatch.

## Scope flag

This is a single coherent spec — every system needs every other system to demonstrate value (panels need enemies, enemies need shock, shock needs targets, etc.) — but the implementation plan will likely break out into 18+ tasks. Realistic execution: 1.5–2 sessions via subagent-driven-development. If the plan grows to 25+ tasks, consider splitting:
- **B1**: panels + Crawler + shock + carbon + repair, no HP/revives/waves yet. Endless-mode minimum.
- **B2**: HP + revives + wave manager + city HP + win/loss states.

The plan-writer's call: keep as one spec if the dependency graph is tight; decompose if the tasks fall into two natural clusters with a clean cut between them.
