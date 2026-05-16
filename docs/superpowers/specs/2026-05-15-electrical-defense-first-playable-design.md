# Electrical-defense: first playable round

*Design spec. The implementation plan that translates this into tasks is a separate document, to be written after this design stabilizes. See `docs/superpowers/plans/2026-05-15-larger-maps-and-sprint.md` for the pattern.*

> **⚠️ Superseded for the B2 portion.** B1 (panels + Crawler + uncharged shock + carbon + repair) shipped from this spec at commit `4ec9a91`. The B2 portion of this spec (charged shock, rebuild, HP/revive, waves, city HP, win/loss) is **superseded** by `2026-05-15-layered-tiles-and-priority-ai-design.md`, which re-bases everything downstream of B1 on a layered tile model, weight-based integrity, priority-driven enemy AI, and a top-down twin-stick input model. Read that spec for the canonical post-B1 direction. This spec remains as the historical record of B1's design intent.

## Context

Sub-spec 2 (larger maps + sprint + panel-jump) shipped at commit `03e41f8` and is live at https://grid.clab.su. Players can run, sprint, and panel-jump on the Large Run arena, but there is still no gameplay — no enemies, no panel state, no combat, no objective.

This spec lands the **first complete playable round** of GridForce: a single survival session where players defend solar panels against waves of mutated wildlife, repair damage with carbon dropped by kills, and either survive 5 waves or lose to city HP draining / all players going down.

The design is anchored in the original GridForce concept doc, pasted verbatim in [Appendix A](#appendix-a-original-gridforce-concept-doc-canonical-source). Future tool specs (electrodes, discharge, magnet, etc.) build on top of this foundation.

## Concept & setting

**Pitch.** Co-op electrical tower-defense vs hordes of mutated wildlife trying to break into the last city.

**Setting.** Far-future dystopia. What's left of human society lives inside a single dome lined with a grid of solar panels that powers the city. Outside the dome is desolate; the mutated wildlife is desperate. Players are **grid enforcers** patrolling the outside, using electrical equipment to shock animals as they try to break through the panels, and repairing damage before the city loses power.

**Player fantasy.** A tiny enforcer dwarfed by massive creatures, frying them with violent electrical effects, racing to keep the grid alive as the situation gets steadily more hectic.

**Aesthetic anchors** (carried forward as guidance — not first-playable scope):
- Retro / dystopian / desert palette.
- Violent electrical VFX as the visual signature.
- Strong scale contrast: tiny enforcers, massive enemies.
- Music potentially synced rhythmically to gameplay (aspirational).

## Goals and non-goals

**Goals**
- A complete playable survival round: spawn, fight, repair, win or lose.
- Three-state panels (LIVE / DAMAGED / BROKEN) as both the conductive grid and the defensive surface.
- Crawler enemies (the doc's "type 1 — normal pathing") with deterministic AI: spawn at edge → walk to nearest panel → attack → walk through holes → exit and damage the city.
- **Local shock** as the core verb, in both **uncharged** (tap) and **charged** (hold) variants, per canon.
- Carbon as the universal currency closing the loop between killing, repairing, and rebuilding.
- Hold-to-repair as a real game-feel beat (DAMAGED → LIVE).
- **Expensive BROKEN-tile rebuild** as a relief-valve verb so players retain agency over their grid late in the run.
- Player HP with downed/revive states for co-op stakes.
- Wave structure with escalating budgets, looped via a new `loopPhases` field on `StageDef`.
- City HP as the global loss timer.
- Win state on surviving wave 5.

**Non-goals**
- Other tools from the doc: electrodes (3e), discharge (3f), push/pull (3g), bright panel / walls / reinforce tile (3h). All deferred.
- The doc's other enemy types: red-toned attackers (type 2) and bosses (type 3). Deferred to 3i.
- Tool-unlock progression / persistence / continues / lives meta-game (3j).
- Multiple stages with mixed grid sizes mid-run.
- AI partner gameplay (the doc's "tag" mechanism for cooperating with AI on electrodes is deferred to 3e).
- Aesthetic polish beyond minimum readability (sirens, screen shake, electrical particle systems are their own spec).
- AOI culling. Wave budgets keep entity counts well under the existing snapshot envelope.

## Design

### Panel state machine

Each grid cell holds one of:

- **LIVE** — bright, full power, conducts electricity, blocks enemy passage.
- **DAMAGED** — cracked, no conduction, still blocks enemy passage.
- **BROKEN** — pit/hole, no conduction, **passable by enemies**.

Transitions:

| From → To | Trigger | Cost | Duration |
|---|---|---|---|
| LIVE → DAMAGED | Crawler attacks the tile | — | 0.5s of contact (placeholder) |
| DAMAGED → BROKEN | Crawler attacks the tile | — | another 0.5s of contact (placeholder) |
| DAMAGED → LIVE | Player completes a hold-repair on the tile | 1 carbon | `REPAIR_DURATION_S = 1.5s` (placeholder) |
| BROKEN → LIVE | Player completes a hold-rebuild on the tile | `REBUILD_CARBON_COST = 10` carbon | `REBUILD_DURATION_S = 4.0s` (placeholder) |

**Rebuild rationale.** The original doc frames BROKEN as effectively permanent ("creatures will just go through those openings, and it gets a lot harder pretty quickly"). Rebuild preserves that intent — at 10× the carbon cost and ~3× the duration of repair, it's a deliberate late-run commitment, not a routine action. But it gives players a relief-valve so a single bad wave doesn't doom the run.

**Render:** LIVE is the existing solar-panel tile; DAMAGED overlays a crack pattern + dimmed alpha; BROKEN replaces the tile with a darker pit/hole sprite (or renders nothing, exposing a "void" background). Specific visual treatment is for the implementation pass.

### Crawler enemy

The Crawler corresponds to the doc's **type 1** enemy: normal pathing creatures that try to break through panels. First playable layers contact-damage onto type 1 so players have co-op stakes (down/revive); the doc's type 2 (red-toned, deliberately attacks players) and type 3 (bosses) stay deferred.

**AI behavior:**
- Spawn on a random edge tile at the start of a wave.
- **APPROACHING**: walk straight toward the nearest LIVE or DAMAGED panel adjacent to the outside. If multiple panels equidistant, prefer one nearest an existing BROKEN tile (so Crawlers funnel through openings rather than spreading damage uniformly).
- **ATTACKING**: pinned in place adjacent to a target panel; advances that panel's degradation timer. When the panel breaks, transition to TRANSITING.
- **TRANSITING**: walk through the BROKEN tile toward the opposite edge. When the Crawler's centre crosses the world edge, decrement city HP by 1 and remove the Crawler.

**Player contact:** a Crawler whose centre is within `(PLAYER_RADIUS + CRAWLER_RADIUS)` of a non-downed player drains the player's HP at `CRAWLER_CONTACT_DPS` (first-pass placeholder). Downed players are invisible to contact damage (Crawlers walk over without piling on).

Specific speeds, sizes, and HP values are first-pass placeholders for the implementation plan to set and the playtest pass to tune. Conceptually: a Crawler walks slower than a player walks, takes one uncharged shock to kill, and is dangerous in groups rather than individually.

### Wave manager + `loopPhases` extension

Extend `StageDef` with an optional `loopPhases: boolean` field. When true, the room wraps from the last phase back to phase 0 instead of advancing to the next stage. This enables a stage to host "wave 1, wave 2, wave 3 …" without authoring N stage definitions.

The first-playable run, `td-prototype`, has one stage with phases `[prepare, wave, cleanup]` and `loopPhases: true`. Wave budgets escalate per wave (placeholder curve: wave 1 = 8 enemies, increasing through wave 5 = ~24). When the wave's kill goal is met (every Crawler from this wave has died OR exited), the server advances from `wave` to `cleanup`. When `cleanup` ends, the framework normally loops back to `prepare`, except: if doing so would push `currentWave` past `WAVE_GOAL = 5`, the framework instead falls through to `advanceStage()`, which transitions the room into `'run-end'` (since the run has only this one stage).

This keeps Run/Stage/Phase semantics clean: hitting the wave goal = stage complete = run complete.

### Combat — local shock

Per the doc, local shock has two variants. The first playable ships both.

**Uncharged (tap).** Rising-edge of the shock input fires immediately:
- Pulse affects the 4 cardinal neighbor tiles that are LIVE — diagonals and DAMAGED/BROKEN tiles do not conduct.
- Any Crawler standing on an affected tile takes 1 damage. Crawlers are 1-HP for first playable, so this is a one-shot.
- Cooldown: `SHOCK_COOLDOWN_S = 0.25` (placeholder).
- Doc framing: "low damage, ineffective for larger enemies, too risky for faster moving enemies." That distinction reactivates when bigger/faster enemies arrive in 3i; in first playable all enemies are Crawlers and one-shot regardless.

**Charged (hold).** Holding the shock input builds charge:
- Visible charge level on the player (a ring or aura) tells the player and remote teammates how charged they are.
- After `SHOCK_CHARGE_TIME_S = 0.6s` (placeholder), the pulse becomes "fully charged."
- On release of a fully-charged shock: pulse propagates along the LIVE conduction graph up to manhattan distance 2 in each cardinal direction (still no diagonals, still no conduction through DAMAGED/BROKEN). Affects every Crawler standing on any reached tile.
- On release before full charge: emits an uncharged pulse (no penalty for misclicks).
- Cooldown after a fully-charged release: `SHOCK_CHARGE_COOLDOWN_S = 0.5s` (placeholder).
- First-playable payoff: **range and breadth** (multi-tile, multi-enemy in one pulse), not damage — Crawlers are still 1-HP. The damage-tier distinction in the doc reactivates with bigger enemies.

**Wire/input envelope:** the existing `shock` bit becomes a held-state bit (server tracks how long the player has held it). PlayerState carries the current hold duration so remote clients can render the charge ring. No new input bit needed beyond the one the spec already adds for `shock`.

### Carbon — universal currency

Carbon is GridForce's universal economy, per the doc. Crawlers drop a Carbon pickup at the kill location on death; pickups have a TTL (~10s placeholder); a player walking near a pickup collects it (clamped to a max stack of 99 to fit a u8).

First-playable spends:
- Panel repair (DAMAGED → LIVE): **1 carbon**.
- Panel rebuild (BROKEN → LIVE): **10 carbon**.

Future spends (out of scope for this spec, listed for context):
- Electrode placement, discharge ultimate, magnet, bright panel decoy, walls, reinforce tile.

The 10× cost gap between repair and rebuild is felt: rebuild is a deliberate strategic commitment, not a routine action.

### Repair + Rebuild

Both transitions share one `repair` input bit:

- **DAMAGED tile under the player, hold `repair`, carbon ≥ 1**: progress timer climbs over 1.5s; on completion, tile → LIVE, deduct 1 carbon, reset timer.
- **BROKEN tile under the player, hold `repair`, carbon ≥ 10**: progress timer climbs over 4.0s; on completion, tile → LIVE, deduct 10 carbon, reset timer.
- **LIVE tile under the player**: no-op.
- **Insufficient carbon for the tile's current state**: no progress accrues (clear feedback: nothing happens).
- **Release the input OR leave the tile mid-repair**: reset timer to 0.
- **Crawler hitting the player mid-repair** doesn't directly cancel the repair, but the player will either move away or die, both of which reset the timer naturally.

Server picks the destination state and cost from the tile currently under the player. The progress timer is visible to remote clients so teammates can see who's mid-repair.

Doc note: the doc says "takes a couple seconds at first but speeds up as you get upgrades." First playable ships only the base speed; speed-up upgrades belong to the eventual tool-unlock progression spec (3j).

### Player HP + revives

- Players spawn with `hp = 100`.
- Crawler contact drains `CRAWLER_CONTACT_DPS` HP/sec (placeholder).
- At HP = 0: player becomes `downed`. They can't move, fire, jump, or repair while downed.
- A non-downed teammate within `REVIVE_RANGE = panelSize * 1.5` (~1.5 tiles) accumulates revive progress on the downed player at a fixed rate. After 3 seconds: the downed player is revived at HP = 50.
- **Multiple teammates in range do not speed up the revive** — the timer accumulates at a fixed rate so long as at least one teammate is there.
- Revive progress resets if no teammate remains in range.

**Loss condition (player side):** if every player in the room is `downed` simultaneously, the room transitions to `'run-end'` with a "WIPE" headline (computed client-side from the snapshot at transition).

### City HP + win/loss

- Room tracks `cityHp` (starts at 100; placeholder).
- Each Crawler that exits through a BROKEN tile decrements `cityHp` by 1.
- If `cityHp` reaches 0: room → `'run-end'` with "CITY LOST" headline.
- Surviving wave 5's cleanup phase → room → `'run-end'` with "VICTORY" headline.

Per-room counters maintained for the run-end summary panel: total kills, panels permanently broken, carbon spent on repairs/rebuilds.

### Wire format envelope

- **Schema version bumps 11 → 12.**
- `PlayerInput` adds `shock` and `repair` bits; `shock` is held-state rather than rising-edge.
- `PlayerState` adds: `hp`, `downed`, `carbon`, `repairProgressS`, `reviveProgressS`, `shockCooldownS`, `shockHeldS`.
- Snapshot adds: panel-state array (RLE-encoded), `cityHp`, `currentWave`, per-room counters, and two new entity groups (Crawler, Carbon).
- Welcome adds: full panel-state byte array (raw, joiner-friendly).
- New EntityTypes: `Crawler` and `Carbon`.

Bandwidth envelope estimate at 36×24 grid, 4 players, 20 Hz snapshots: a few hundred bytes added per snapshot — comfortably inside the existing budget.

*Exact byte layouts, quantization scales, and encoder/decoder structure are specified in the implementation plan.*

## Gameplay scenarios to validate

The first-playable build must demonstrate these player-observable behaviors. Concrete test files, framework choices, and TDD steps are decisions for the implementation plan.

**Panels**
- A LIVE tile shows as a bright solar panel; DAMAGED visibly degraded; BROKEN visibly a hole.
- A Crawler in contact with a LIVE tile takes it to DAMAGED in 0.5s of contact.
- A Crawler in contact with a DAMAGED tile takes it to BROKEN in another 0.5s.

**Crawlers**
- A Crawler spawned at an edge walks toward the nearest LIVE/DAMAGED panel.
- A Crawler stops at its target panel and attacks until it breaks.
- A Crawler walks through a BROKEN tile and exits the opposite side.
- An exiting Crawler decrements city HP by 1.

**Local shock — uncharged**
- Tap shock with a Crawler one tile away on a LIVE tile: Crawler dies.
- Tap shock with a Crawler on a DAMAGED tile adjacent to the player: Crawler survives (no conduction).
- Tap shock with a Crawler on a diagonal LIVE tile: Crawler survives (4-cardinal only).
- Tap shock twice within 0.25s: second tap has no effect (cooldown).

**Local shock — charged**
- Hold shock for 0.6s and release: pulse reaches up to manhattan-2 along LIVE-connected tiles.
- Release before 0.6s: equivalent to a tap (uncharged pulse).
- Hold past 0.6s + release: payload is the same (no overcharge — full charge is the cap).
- Charge level visible to the player and remote teammates while building.

**Carbon**
- Killing a Crawler drops a Carbon pickup at the kill location.
- A Carbon pickup expires after ~10s.
- Walking over a pickup increments the player's carbon by 1 and removes the pickup.

**Repair**
- Hold `repair` on a DAMAGED tile with ≥1 carbon for 1.5s: tile → LIVE, carbon decrements by 1.
- Release mid-repair: progress resets.
- Walk away mid-repair: progress resets.
- Hold `repair` on a LIVE tile: no effect.
- Hold `repair` with 0 carbon: no effect.

**Rebuild**
- Hold `repair` on a BROKEN tile with ≥10 carbon for 4.0s: tile → LIVE, carbon decrements by 10.
- Hold `repair` on a BROKEN tile with <10 carbon: no progress.

**HP and revives**
- Crawler contact drains player HP at the configured DPS.
- Player HP at 0: player becomes downed; can't act.
- A teammate within 1.5 tiles of a downed player for 3s: downed player is revived at HP 50.
- Teammate leaving range mid-revive: progress resets.
- All players downed simultaneously: room → run-end (WIPE headline).

**City HP and win/loss**
- Crawler exit decrements city HP by 1.
- City HP at 0: room → run-end (CITY LOST headline).
- Surviving wave 5's cleanup: room → run-end (VICTORY headline).

## Verification (design completeness)

1. Every system has a defined state, transitions, and player-facing feedback.
2. Every player action has a defined input, server-side effect, and visible response.
3. Every win/loss path is enumerated and produces a distinct run-end headline.
4. The original GridForce concept doc is captured in [Appendix A](#appendix-a-original-gridforce-concept-doc-canonical-source) so this spec is self-contained.

Build, deploy, and manual-playtest verification belong to the implementation plan.

## Scope flag

This is one coherent design — every system depends on every other to demonstrate value. The implementation plan that follows may, at its author's discretion, decompose this into sub-plans:

- **B1**: panels + Crawler + uncharged shock + carbon + repair. Endless-mode minimum.
- **B2**: charged shock + rebuild + HP/revives + waves + city HP / win-loss.

That split is an implementation-plan decision; this design spec keeps the systems integrated.

## Open items intentionally deferred

- **Tuning values**: charge time, charge cooldown, rebuild cost, rebuild duration, carbon-per-kill, wave-budget curve, Crawler speeds and sizes, contact DPS, repair duration, revive duration. All ship as first-pass placeholders; calibration is a playtest activity owned by the implementation plan and iteration.
- **Whether the second combat verb is *charged shock* or something else** (e.g., a minimal discharge or push). This spec proposes charged shock because it is the doc's literal completion of "Local shock" and the smallest scope-true-to-canon extension. If a different second verb belongs in first playable, edit this section before generating the implementation plan.

---

## Appendix A: Original GridForce concept doc (canonical source)

The doc lives only on the creator's local machine. Pasted verbatim below so this spec is self-contained.

> GridForce
> Title:
> GridForce
>
> Pitch:
> Cooperative electrical weapon and tower-defense mechanics meets hordes of enemies through an escalating difficulty stage progression
>
>
> Story:
> It's pretty far into the future, a dystopian setting. Much of what's left of human society is inside a single dome lined with a grid of solar panels that power the city. The rest of the planet is fairly desolate. The outside wildlife that has long since mutated and grown desperate is constantly trying to break into the city. There are grid enforcers that patrol the grid on the outside and stop the mutated wildlife from getting in. They use their electrical equipment to shock tiles and literally fry the animals as they're trying to break through the tiles. These enforcers must also repair the damaged and broken solar panels otherwise the city begins to lose power, they can't shock through the tiles, and animals can more easily break through inactive panels. You and your friends are grid enforcers. The threats keep getting worse and worse and it's up to you guys to put a stop to the threats once and for all.
>
>
> Mechanics:
> The players will path around in analog motion but also have panel-to-panel jump motions to get around the stage. It is an aerial perspective and you're running around defending a massive onslaught of enemies with larger enemies popping up too. THINK SMASH TV.
>
>
> The players have access to an increasing number of tools to help deal with enemies that they unlock throughout the game.
>
>
> (1) Local shock -
> uncharged is just 1 tile adjacent to the player shocking enemies and dealing low damage. Ineffective for larger enemies and too risky for faster moving enemies
> - charged is 2 tiles adjacent to the player (takes some time to do so)
> (2) Repair -
> takes a couple seconds at first but speeds up as you get upgrades to repair damaged or broken solar panels
> (3) Electrodes -
> Place an electrode on the ground that you can shock, however it does not travel anywhere unless another electrode is placed in the same row/column (?) Your teammates can work with you placing temporary electrodes so you can take out larger clusters of creatures as well as the bosses when the other tools are not as effective. Electrodes will do far more damage than local shocks but they require teamwork to execute. Players will likely not be able to place a bunch of electrodes at once.
> (4) Discharge -
> Somewhat like an ultimate attack/board clear. Shocks every live tile on-screen. Probably does high damage as well.
> (5) Push/Pull magnetic tool -
> Allows you to pull teammates toward you or push them away from you to help each other survive and navigate the scene while you're being bombarded.
> (6) Bright Panel -
> Like a lantern, the bright panel will attract smaller enemies toward it. You use it as a distraction when things start becoming unmanageable.
> (7) Walls (?)
> Adding walls to press enemies into specific areas
> (8) Reinforce Tiles -
> Allows you to reinforce tiles so they do not crack as easily
>
>
> How does repairing work?
> When you fry creatures they will drop ___CARBON___ that you will use to repair broken and damaged tiles. If you save up enough you can also build other useful things like potentially requirements for discharge/magnets/electrodes.
>
>
> Damaged Tiles?
> Damaged tiles are no longer LIVE so they will not TRANSMIT electricity through them. Players must balance the repair mechanic with their electric extermination efforts.
>
>
> Enemy types
> 1. Normal creatures just path around and try to break in
> 2. Red toned creatures attack players in addition
> 3. Bosses can be either tone but are generally very large
>
>
> Extras?
> Probably would have difficulty modes adjusting the rate at which things get more violent and maybe # of lives/continues
>
>
> Potentially have the players move between the panels instead of on the panels directly ?
>
>
> Aesthetic:
> Not sure. Probably retro-y but maybe 3d with 2-dimensional movement and an aerial perspective. I like the idea of the grid enforcers being TINY compared to the massive mutated creatures trying to break in with lots of electricity animations that look really violent and cool. Definitely dystopian futurey robotic deserty desolate themed. Music no idea whatsoever. Needs to go well with the gameplay that's all I know. I also love the idea of music synchronizing somewhat rhythmically with gameplay.
>
>
> I'm a little concerned about the grid getting boring after a couple of stages, just scenery wise so maybe there will have to be tiers to the grid like where more power is coming from and have the color scheme and decorations on the grid change or something. Maybe as you climb to the top of the dome. Then final boss at the top of the dome, or something.
>
>
> How does losing work:
> Everyone dies
> Too many enemies break into the city
> Once tiles are broken through you can't repair them anymore so it gets a lot harder pretty quickly at that point creatures will just go through those openings (i was thinking there's a set # of creatures per screen and they all won't directly path to the opening but if it breaks in the beginning of a screen then you might lose on that screen but if it's later on in the screen probably not).
>
>
> Multiplayer:
> I was thinking 1-4 players local COOP with AI if you aren't able to have friends play with you but might be rather difficult to get AIs to work with you on electrodes. Might need a signalling mechanism to tell the AI to work with you right as you place electrodes.
>
>
> I also thought of a game mode where one player is the big monster in the middle and the rest are on the outsides but not sure if that will be fun or work well.
>
>
> Progression:
> Think SMASH TV
> You're moving along the grid stage by stage, clearing all creatures on the screen, then moving to another screen and more creatures start showing up. I'm wanting the gameplay to get more and more hectic as the stages go on. Requiring more and more electrode teamwork and even
> Synchronizing discharge ultimates so you can manage the creature load.
>
>
> I was thinking the solar cells would get smaller and smaller as you make your way to the top of the dome throughout the game. The gameplay would naturally get harder as well.
>
>
> Below is a basic proof of concept image showing local shocking, electrode usage, cracked solar panels, the grid enforcers, and some creatures
> basic demonstration.png
