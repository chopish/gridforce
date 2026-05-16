# Layered Tiles & Priority AI

*Design spec. The implementation plan(s) that translate this into tasks are separate documents, to be written after this design stabilizes. This spec is the canonical replacement for the B2 portion of `2026-05-15-electrical-defense-first-playable-design.md` and reframes the whole gameplay roadmap on top of it.*

## Context

The B1 build (commit `4ec9a91`, live at https://grid.clab.su) ships a flat panel model: three states (LIVE/DAMAGED/BROKEN) and a deterministic per-tile attack timer. The original GridForce concept doc (`docs/GridForce.txt`), on a re-read, points at a richer structure: multiple z-layers (panels sit on top of a dome; addons sit on top of panels), structural integrity driven by enemy *weight*, and priority-driven enemy AI rather than a hard-coded state machine.

This spec lays the foundation for the rest of GridForce: a layered tile data model, weight-based integrity, a cursor-aimed combat verb set, top-down twin-stick input, and the camera + minimap apparatus that makes a larger and more nuanced grid playable.

It is **load-bearing** — almost everything downstream sits on top of it.

## Genre & input model

GridForce is a **top-down twin-stick shooter** in the family of Alien Swarm. Movement is WASD relative to camera; aim is cursor-relative, fully 360°. Player sprites face the cursor.

### Bindings (default)

| Verb | Binding |
|---|---|
| Move | WASD (camera-relative) |
| Aim | Mouse cursor |
| Uncharged shock | Left mouse / F (rising-edge) |
| Charged shock | Left mouse / F (held → released after ≥ charge time) |
| Repair / Rebuild | Right mouse / R (held) |
| Panel-jump targeting | Hold Shift |
| Panel-jump cursor | WASD (during Shift-hold) |
| Re-center camera | Home |
| Free pan | Hold middle mouse + drag |
| Zoom | Mouse wheel |

**Sprint is removed** in this redesign. The hold-Shift sprint that shipped in sub-spec 2 is retired. To compensate, default walk speed is raised to roughly the previous sprint speed — about `1.4×` the old walk. Tactical bursts of speed now come from panel-jump, not a held modifier.

## Layered tile model

Each grid cell stacks discrete *layers*. A tile's gameplay behavior at any moment is the composition of its layer states.

| Layer | Name | What lives here | Repairable? | Notes |
|---|---|---|---|---|
| **L0** | Dome structure | Wall of the city dome | **No** — destroyed L0 is permanent | The actual barrier between players and the city interior. Does not conduct. |
| **L1** | Solar panel / floor | Solar tile, electrically conductive | Yes (DAMAGED→LIVE; gone→LIVE via Rebuild) | What the doc has historically called "panels." |
| **L2** | Addon / surface | Reinforcement, bright panel, future tools | Yes (place / replace) | Non-blockers; modify behavior of L1 or attract enemies. |
| **L3** | Entities | Players, mites, walls, electrodes | n/a — dynamic | Where the action lives. |
| **L4** | Above | Flyers in transit, descending boss segments | n/a | **Future**; no L4 entities in C1. |

Special state: when **L0** is fully destroyed at a cell, that cell becomes a **passage** (informally **L-1**). Enemies walk straight through unimpeded. The cell can still host L2 addons or L3 entities placed on top of the passage — e.g. a wall could plug a passage even after the dome is lost there.

### Per-layer state

Each layer present at a cell carries:
- `hp` — current health
- `maxHp` — full health for that layer's current "kind"
- `armor` — damage reduction applied per damage event
- Layer-specific fields: addon kind (for L2), wall kind (for L3 walls), etc.

Layers do **not** auto-heal. All recovery is player-driven via the repair / rebuild verbs (or future tools).

### Damage flow

Damage targeted at a cell is consumed by the topmost present layer:
- L2 addon present → addon takes the hit first; once destroyed, future hits target L1.
- No L2 → L1 takes hits.
- L1 gone → L0 takes hits.
- L0 gone → passage; the cell can't take "structural" damage anymore.

A bug damages exactly the topmost current layer per tick. This keeps the model deterministic and prevents simultaneous-layer cases.

## Weight integrity

Replaces the deterministic per-tile attack timer from B1. Each bug carries a `weight` (mite = `1`; future variants scale up). The sum of bug weights on or adjacent to a tile drives damage to that tile's topmost layer.

Two regimes:

| Total weight `w` contributing to tile | Damage / second to topmost layer |
|---|---|
| `w ≤ WEIGHT_THRESHOLD` | `BASE_DOT_RATE × w × max(0, 1 − armor / MAX_ARMOR)` — slow grind |
| `w > WEIGHT_THRESHOLD` | `BASE_DOT_RATE × (w + (w − WEIGHT_THRESHOLD)²)` — quadratic blow-up; tile under siege |

Placeholders for first pass: `WEIGHT_THRESHOLD = 4`, `BASE_DOT_RATE = 2 hp/s`, `MAX_ARMOR = 100`. All tunable in playtest.

**Adjacency rule:** the tile itself plus its 4 cardinal neighbors contribute weight. This keeps a swarm's damage focal point at its center rather than smeared across diagonals.

A bug is "doing structural damage" any tick its weight is loaded onto a tile *and* that tile has a topmost layer to damage. A bug standing on an L-1 passage with nothing else to chew is idle for structural purposes (its next action is decided by the priority engine in C2).

## Conduction

Conduction lives at L1. A cell is **LIVE-conductive** when:

- L1 is present (panel not destroyed), AND
- `L1.hp / L1.maxHp ≥ CONDUCTION_THRESHOLD` (proposed `0.5`).

Below the threshold, the panel reads as **DAMAGED** visually and stops conducting, but still blocks bugs from descending to L0.

The conduction graph propagates strictly along **4-cardinal** LIVE-conductive edges. Diagonals never conduct.

## Combat — shock resolution

Both shock variants use cursor-aim. Aim angle is computed from `cursor_world_pos − player_world_pos`, then **snapped to the nearest cardinal** (N/E/S/W) at resolution time. This gives the player 360° aim feel while keeping conduction rules consistent with the grid.

### Uncharged shock (tap)

- Rising-edge of the shock input fires immediately.
- Snap aim to nearest cardinal. The **one tile** in that direction takes the pulse if it is LIVE-conductive.
- Any bug whose center is on that tile takes 1 damage.
- Cooldown: `SHOCK_COOLDOWN_S = 0.25` (placeholder).
- **Behavior change vs B1:** B1 fired on all 4 LIVE cardinal neighbors at once. The redesign fires on **one** — the cursor-pointed cardinal. More skillful, more doc-faithful ("uncharged is just 1 tile adjacent" — singular).

### Charged shock (hold)

- Holding the shock input builds charge over `SHOCK_CHARGE_TIME_S = 0.6s` (placeholder).
- A visible charge ring on the player tells the player and remote teammates how charged it is.
- On release at full charge: snap aim to nearest cardinal. The pulse hits tile 1 (one step out) and tile 2 (two steps out) along that line. Tile 2 receives the pulse only if tile 1 was LIVE-conductive — i.e. the conduction graph determines reach, doc-canonical.
- Pre-full-charge release: equivalent to an uncharged tap (no penalty for misclicks).
- Cooldown after a fully-charged release: `SHOCK_CHARGE_COOLDOWN_S = 0.5s` (placeholder).
- 1-HP bugs die in one hit either way; the charged variant's payoff is **range** (reaches 2 tiles deep) and **line-clear** (hits two enemies in a row), not damage. The damage distinction reactivates with multi-HP variants in C4.

## Panel-jump

Replaces B1's Space-tap-in-facing-direction with a precision tile-pick.

### Mechanic

1. Hold **Shift** → enter "jump targeting" mode. A cursor sprite appears on the player's current tile; the world dims slightly.
2. Tap WASD: cursor moves 1 tile per tap. Per-axis cap **±2** (5×5 reachable, player at center).
3. Release Shift: player teleports to the cursor tile. Cooldown `PANEL_JUMP_COOLDOWN_S = 0.4s`.
4. Escape (or LMB cancel) while holding Shift: exit mode without jumping; no cooldown spent.

Sequences are positionally additive: `WD` → (1 up, 1 right). `WWD` → (2 up, 1 right). `DD` → (2 right). The player can jump onto any cell within the box that has a standable surface — L1 (any state) or L2 — but not onto an L-1 passage (no floor to stand on).

This is a planning-style movement verb: pause to aim, then commit. It rewards fast input chains (`WD`-flick for an instant diagonal) for skilled players, and gives slower players room to think.

## Camera

Top-down orthographic; renderer-only — the server is camera-agnostic.

| Verb | Binding | Effect |
|---|---|---|
| Follow (default) | n/a | Camera smoothly trails the local player |
| Zoom | Mouse wheel | `0.5×` to `2.0×`, pivot on cursor; settings expose min/max and step |
| Free pan | Hold middle mouse + drag | Decouples from follow until re-centered |
| Re-center | Home, or double-tap middle | Snap back to follow-player |
| Edge-pan | **Off by default**; toggleable in settings | When on: cursor in edge band nudges camera; sensitivity slider and dead-zone band tunable |

Camera state is per-client; multi-player cameras are independent.

## Minimap

Top-right corner overlay, fixed-size (~`180×180px` placeholder). Reads the same server state as the main renderer; no new wire data is added by the minimap itself.

- Per-cell tile state, color-coded:
  - **LIVE-conductive**: bright color
  - **DAMAGED**: amber
  - **L1 gone, L0 intact**: dark
  - **L0 passage**: red/black
- L3 entities: players (cyan), bugs (red), future entity classes get their own glyphs.
- **Danger highlight:** tiles with weight ≥ `DANGER_WEIGHT_THRESHOLD` pulse a yellow ring.
- **Off-screen ping:** bug dots outside the current camera viewport blink slightly faster than on-screen ones, so the player notices swarms forming away from where the camera is pointed.
- **Click-to-pan:** clicking a minimap cell switches the camera to free-pan mode centered on that cell. `Home` re-centers as usual.

## Wire format envelope

- Schema version bumps `12 → 13`.
- Per-tile state expands from a single `u8 panelState` to a packed multi-layer struct: layer HP values, addon kind, and armor/flags. Encoded with RLE per layer to keep snapshot bandwidth bounded.
- `PlayerInput` adds:
  - `shock` becomes held-state (the bit exists in v12; semantics change).
  - `jumpHeld` (Shift), `jumpCursorDx`/`jumpCursorDy` (small signed offsets, ±2 each, used during a Shift hold).
- `PlayerState` adds: `facingRadCursor` (cursor-derived facing, distinct from velocity-derived), `shockHeldS`.
- New entity types and per-room state added by C2/C3/C4 (Mite, telegraphs, wave state, city HP, etc.) — **not in C1**.

Bandwidth envelope estimate at 36×24 grid, 4 players, 20 Hz snapshots: comfortably inside the existing budget once RLE applies to per-layer tile state.

*Exact byte layouts, quantization scales, and encoder/decoder structure are specified in the implementation plan.*

## Gameplay scenarios to validate (C1 only)

C1 should be **behavior-compatible** with B1's visible gameplay loop for a single mite-equivalent bug:

- A bug at the edge walks toward and damages a panel; the panel goes through LIVE → DAMAGED → gone over a few seconds of contact.
- A player on a DAMAGED panel can repair it to LIVE (carbon-cost rules unchanged from B1).
- An uncharged shock pointed at a LIVE-conductive tile with a bug on it kills the bug.

Plus the new scenarios C1 makes visible:

- Five bugs piled on a panel destroy it noticeably faster than one bug (quadratic regime kicks in).
- After L1 is destroyed at a cell, additional bug weight on that cell starts grinding L0 instead.
- A cell with destroyed L0 reads as a passage; bugs walk through it without further damage.
- Charged shock pointed at a long row of LIVE tiles reaches 2 tiles in that direction.
- Charged shock fired down a row where tile 1 is DAMAGED stops at tile 1 (no conduction into tile 2).
- Hold-Shift + `WD` + release lands the player on the NE neighbor tile.
- Mouse wheel zooms; middle-drag pans; minimap shows the full grid with danger highlights and an off-screen ping when a swarm is forming away from the camera.
- Cursor-pointed uncharged shock hits only the cardinal it points at — not all four.

## Roadmap (this design and what stands on it)

| Sub | Scope |
|---|---|
| **C1** *(this spec)* | Layered tile data model, weight integrity, conduction from L1 HP, cursor-aimed shock resolution, panel-jump rework, walk-speed change (sprint removed), camera + zoom + pan + edge-pan-option, minimap. Behavior-compatible with B1's visible single-bug loop. |
| **C2** | Priority-driven AI engine (stochastic priority profile, attention modifier, frustration / boredom meter), **Mite** as canonical class. Replaces today's Crawler state machine. Attack-windup player damage (no on-contact drain). |
| **C3** | Stakes & loop: charged shock VFX/feel, rebuild (L1 only — L0 not rebuildable), HP/revive, waves (`prepare/wave/cleanup` with `loopPhases`), city HP, win/loss/run-end summary. L2+ rebuild over destroyed foundation. |
| **C4** | Spawn telegraphs, wave HUD, additional enemy classes (Brute, Burrower, …) expressed via the priority engine. |

Each of C2/C3/C4 will have its own design spec when its turn comes; this section is a scope outline, not a binding spec for them.

## Non-goals (for C1 specifically)

- No new enemy types or AI changes. The current Crawler keeps its state machine, just damages via the new weight system instead of the old timer.
- No charged shock VFX polish beyond a minimum-readable charge ring.
- No revive, HP, wave, or run-end UI — those land in C2/C3.
- No L2 addon *catalog* beyond the data model. The actual reinforcement and bright-panel tool specs live separately.
- No tile-rendering art passes — L1 dimming for DAMAGED, an L0 sprite for "panel-gone", and a passage sprite for "L0-gone" is enough.
- No AOI culling. Wave budgets stay modest in C3; full snapshot suffices.
- No tutorial / onboarding for the new input model. Player learns by doing or via a future help overlay spec.

## Open items intentionally deferred (placeholders to set in playtest)

- `WEIGHT_THRESHOLD`, `BASE_DOT_RATE`, `MAX_ARMOR`
- `CONDUCTION_THRESHOLD` (proposed `0.5`)
- `SHOCK_CHARGE_TIME_S`, `SHOCK_CHARGE_COOLDOWN_S`, `SHOCK_COOLDOWN_S`
- `PANEL_JUMP_COOLDOWN_S`
- New default walk speed (proposing `1.4×` old walk; tunable)
- Camera zoom min/max, edge-pan sensitivity defaults
- Minimap size, color palette, danger-ring frequency
- Per-layer starting HP values (`L0.maxHp`, `L1.maxHp`, default L2 `maxHp`)
- Armor effect: flat reduction vs % reduction (proposing **flat per damage event**)
- Whether the panel-jump-targeting cursor moves in tile-cell steps only or also allows sub-tile placement (proposing **tile-cell steps only** for clarity)

## Verification (design completeness)

1. Every layer has a defined state, transitions, damage flow, and player-facing feedback.
2. Every player action (move, aim, shock, repair, jump, camera, minimap interaction) has a defined input, server-side effect, and visible response.
3. Behavior compatibility with B1's visible loop is enumerated.
4. Schema bump is acknowledged; the existing B1+B2 spec gets a forward pointer to this spec.

Build, deploy, and manual-playtest verification belong to the implementation plan.

---

## Appendix A — How this aligns with the original concept doc

This redesign maps directly back onto `docs/GridForce.txt`:

- "uncharged is just 1 tile adjacent to the player" → uncharged shock hits ONE tile (cardinal, cursor-pointed). The B1 four-cardinal AoE was an over-reading; the doc says singular.
- "charged is 2 tiles adjacent" → charged shock reaches 2 tiles along the cursor direction, gated by conduction.
- "damaged tiles are no longer LIVE so they will not TRANSMIT electricity" → `CONDUCTION_THRESHOLD` on L1 HP.
- "Once tiles are broken through you can't repair them anymore" → L0 destroyed = permanent passage. L1 can be rebuilt.
- "Reinforce Tiles — Allows you to reinforce tiles so they do not crack as easily" → L2 addon layer with armor.
- "Walls (?) Adding walls to press enemies into specific areas" → L3 wall entity (deferred to a later spec; the data model accommodates it).
- "Bright Panel" → L2 addon kind.
- "Electrodes / Discharge / Push-Pull / Reinforce" — all deferred, all accommodated by the layered + priority structure.
- "Solar cells get smaller as you make your way to the top of the dome" → camera zoom is now first-class, so tighter grids at higher stages are a tuning parameter, not a separate engineering project.
