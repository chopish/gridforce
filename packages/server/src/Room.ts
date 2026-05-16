import { performance } from 'node:perf_hooks';

import {
  CARBON_TTL_S,
  CARBON_PICKUP_RADIUS,
  PLAYER_CARBON_MAX,
  PLAYER_RADIUS,
  CRAWLER_SPAWN_INTERVAL_S,
  CRAWLER_WEIGHT,
  MAX_ALIVE_CRAWLERS,
  SHOCK_BEAM_DAMAGE,
  SHOCK_CHARGE_FULL_S,
  SHOCK_LINGER_TICKS,
  SHOCK_TILE_DAMAGE,
  REPAIR_DURATION_S,
  REPAIR_CARBON_COST,
  CrawlerAIState,
  DEFAULT_DIFFICULTY,
  DEFAULT_RUN_ID,
  ErrorCode,
  ErrorMsg,
  GRID_COLS,
  GRID_ROWS,
  L1_PANEL_MAX_HP,
  LayerKind,
  MAX_PLAYERS_PER_ROOM,
  PlayerJoinedMsg,
  allocateTiles,
  damagePerSecond,
  damageTopmost,
  isPassage,
  topmostLayer,
  traceShockBeam,
  tryPanelJump,
  type BufferedJump,
  type TileBuffers,
  PlayerLeftMsg,
  SERVER_SNAPSHOT_INTERVAL_MS,
  SERVER_TICK_DT_MS,
  SERVER_TICK_DT_S,
  SnapshotMsg,
  WelcomeMsg,
  getRun,
  getRunOrDefault,
  getStage,
  indexOf,
  isValidDifficulty,
  isValidRunId,
  newPlayerState,
  stepCrawler,
  stepPlayer,
  type CarbonState,
  type CrawlerState,
  type CrawlerStepContext,
  type DifficultyValue,
  type GridDef,
  type NpcState,
  type PhaseDef,
  type PlayerId,
  type PlayerInput,
  type PlayerState,
  type RoomPhase,
  type RunDef,
} from '@gridforce/shared';

import type { Connection } from './Connection.js';
import { CrawlerAiManager } from './CrawlerAi.js';
import { Npc } from './Npc.js';
import type { Pilot } from './Pilot.js';
import { WanderBot } from './bots/WanderBot.js';

const MAX_CATCHUP_PHYSICS_TICKS = 8;
const SCHEDULER_GRANULARITY_MS = 4; // never sleep finer than this
const NO_HOST: PlayerId = 0xff;
// Per-room ceiling on NPC count. Real cap will fall out of AOI + budget
// numbers later; for stress tests this is plenty headroom past Phase 0
// targets (300 entities) without letting a stuck client wedge the room
// into an OOM by spamming SetNpcCount(0xffff). Override per-deploy with
// GRIDFORCE_MAX_NPCS — at 8192, snapshot bandwidth is ~1.6 MB/s/client
// (10 B/NPC × 8192 × 20 Hz) so anything substantially higher needs
// AOI/delta encoding before it's safe outside LAN.
const MAX_NPCS_PER_ROOM = Math.max(
  1,
  Math.min(0xffff, Number(process.env.GRIDFORCE_MAX_NPCS) || 8192),
);

// Place new players around the centre, spread on a circle so they don't spawn on top of each other.
function spawnPosition(grid: GridDef, slot: number): { x: number; y: number } {
  const cx = (grid.cols * grid.panelSize) / 2;
  const cy = (grid.rows * grid.panelSize) / 2;
  const r = Math.min(grid.cols, grid.rows) * grid.panelSize * 0.15;
  const theta = (slot / MAX_PLAYERS_PER_ROOM) * Math.PI * 2;
  return { x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r };
}

export type RoomVisibility = 'public' | 'unlisted' | 'private';

export interface RoomOptions {
  // Display name shown in the public listing. Empty for unnamed rooms.
  name?: string;
  // public:   listed at GET /rooms; joinable with code only
  // unlisted: not listed; joinable with code only
  // private:  not listed; requires a valid accessKey (from invite redemption)
  visibility?: RoomVisibility;
  // Hard cap on humans + bots. Clamped to MAX_PLAYERS_PER_ROOM upstream.
  maxPlayers?: number;
}

export class Room {
  readonly pilots = new Map<PlayerId, Pilot>();
  readonly states = new Map<PlayerId, PlayerState>();

  readonly name: string;
  readonly visibility: RoomVisibility;
  readonly maxPlayers: number;
  readonly createdAtMs = performance.now();

  // 'lobby' on creation. Host transitions to 'playing' via StartGame, after
  // which physics steps run. New rooms always start in lobby — Phase 0 has
  // no concept of "rejoining a game in progress with no waiting room".
  // 'run-end' is reached when the final stage's final phase elapses; the
  // room sits there until torn down.
  phase: RoomPhase = 'lobby';
  // PlayerId of the human host, or NO_HOST (0xff) if there's no human in
  // the room. Bots cannot be host. Promotion happens automatically: first
  // human to join becomes host; on host leave the next human is promoted.
  hostId: PlayerId = NO_HOST;
  // Pre-game selections, settable from the lobby UI by the host. Defaults
  // are the only Phase 0 run + Normal difficulty.
  runId: string = DEFAULT_RUN_ID;
  difficulty: DifficultyValue = DEFAULT_DIFFICULTY;
  // Active run state. In lobby, this points at the run the host has
  // selected so the lobby UI's "first stage's grid" is correct; on
  // startGame() it's re-resolved (in case the runId mutated mid-lobby)
  // and the indices reset to 0.
  private run: RunDef = getRun(DEFAULT_RUN_ID);
  private currentStageIndex = 0;
  private currentPhaseIndex = 0;
  private phaseElapsedS = 0;
  // C1 layered tile model: per-layer HP buffers. Replaced the legacy
  // panelStates: Uint8Array (LIVE/DAMAGED/BROKEN trinary) in Task 9. Shock,
  // repair, and crawler AI all read/write this directly now; full rewrites
  // of those subsystems land in Tasks 10-13.
  tiles: TileBuffers = allocateTiles(GRID_COLS, GRID_ROWS);

  // Per-tile sub-integer damage accumulator for the weight-integrity loop.
  // The hp buffers are Uint8 (wire-friendly) so fractional damage per tick
  // (e.g. 2 hp/s × 1/30 s = 0.067 hp) would otherwise be truncated to 1 hp
  // on each assignment, massively over-quantizing damage. We accumulate
  // fractional damage here and only flush whole-integer amounts into the
  // hp buffers via damageTopmost.
  private damageAccum: Float32Array = new Float32Array(GRID_COLS * GRID_ROWS);

  // The active stage's grid. Derived so a stage advance during play
  // automatically swaps it without rewiring every consumer.
  get grid(): GridDef {
    return getStage(this.run.stageSequence[this.currentStageIndex]!).grid;
  }

  private currentPhaseDef(): PhaseDef {
    return getStage(this.run.stageSequence[this.currentStageIndex]!).phaseSequence[
      this.currentPhaseIndex
    ]!;
  }
  // Wandering NPCs spawned by the host as a netcode stress test. Empty
  // by default — host opts in via SetNpcCount keybinds.
  readonly npcs = new Map<number, Npc>();
  private nextNpcId = 0;

  // B1 electrical-defense crawlers. Spawned automatically while playing.
  // The priority-AI manager owns the per-bug task-selection state — bugs
  // are entered when spawned and removed when reaped.
  readonly crawlers = new Map<number, CrawlerState>();
  private readonly crawlerAi = new CrawlerAiManager();
  private nextCrawlerId = 0;
  private crawlerSpawnAccum = 0;

  // B1 carbon pickups. Spawned by combat kills (Task 10); collected by players.
  readonly carbons = new Map<number, CarbonState>();
  private nextCarbonId = 0;

  // Per-player previous shock-bit, used for rising-edge detection on the
  // uncharged-shock tap (Task 11). The wire bit is held-state in v13, so we
  // only fire on shock=true & !prevShockHeld. Cleared in startGame() and on
  // player leave. Task 12 will extend this map (or add a sibling) for the
  // falling-edge charged-release path.
  private prevShockBits = new Map<PlayerId, boolean>();

  // Per-player previous jumpHeld bit, used for falling-edge detection on the
  // panel-jump release (Task 13). The wire bit is held-state ("Shift is
  // currently down"); we trigger the teleport on prevHeld && !held, i.e.
  // the release frame. Cleared in startGame() and on player leave. Kept
  // server-only — never encoded onto wire PlayerState.
  private prevJumpHeld = new Map<PlayerId, boolean>();

  // One-slot input buffer per player. When the player releases Shift during
  // cooldown, the (dx, dy) is parked here and fired automatically on the next
  // tick whose cooldown has drained. Same model the client predicts in
  // PredictedWorld so chained jumps stay smooth even at the edge of cooldown.
  // Server-only; never wire-encoded.
  private bufferedJumps = new Map<PlayerId, BufferedJump>();

  tick = 0;
  private nextPlayerId: PlayerId = 0;
  private startWallMs = 0;
  private lastPhysicsAtMs = 0;
  private lastSnapshotAtMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastNonEmptyAtMs = performance.now();

  constructor(
    public readonly code: string,
    opts: RoomOptions = {},
  ) {
    this.name = (opts.name ?? '').slice(0, 32);
    this.visibility = opts.visibility ?? 'unlisted';
    const cap = opts.maxPlayers ?? MAX_PLAYERS_PER_ROOM;
    this.maxPlayers = Math.max(1, Math.min(MAX_PLAYERS_PER_ROOM, cap));
  }

  get playerCount(): number {
    return this.pilots.size;
  }

  get isEmpty(): boolean {
    for (const p of this.pilots.values()) {
      if (!p.isBot) return false;
    }
    return true;
  }

  get lastNonEmptyAt(): number {
    return this.lastNonEmptyAtMs;
  }

  start(): void {
    if (this.running) return;
    const now = performance.now();
    this.startWallMs = now;
    this.lastPhysicsAtMs = now;
    this.lastSnapshotAtMs = now;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // --- Membership ---

  // Two-phase join: caller reserves a slot, constructs the Connection with
  // the assigned id, then commits. Lets Connection's playerId stay readonly
  // and avoids the awkward "create then mutate" pattern.
  reserveSlot(): { ok: true; playerId: PlayerId } | { ok: false; code: number } {
    if (this.pilots.size >= this.maxPlayers) {
      return { ok: false, code: ErrorCode.RoomFull };
    }
    return { ok: true, playerId: this.allocPlayerId() };
  }

  commitJoin(conn: Connection): void {
    const id = conn.playerId;
    this.attach(id, conn, this.makeSpawnState(id, conn.name));
    if (this.hostId === NO_HOST) this.hostId = id;
    this.broadcastExcept(id, PlayerJoinedMsg.encode({ player: this.states.get(id)! }));
    this.sendWelcome(conn);
  }

  addBot(): { ok: true; playerId: PlayerId } | { ok: false; code: number } {
    if (this.pilots.size >= this.maxPlayers) {
      return { ok: false, code: ErrorCode.RoomFull };
    }
    const id = this.allocPlayerId();
    const bot = new WanderBot(id);
    this.attach(id, bot, this.makeSpawnState(id, bot.name));
    this.broadcastAll(PlayerJoinedMsg.encode({ player: this.states.get(id)! }));
    return { ok: true, playerId: id };
  }

  remove(playerId: PlayerId): void {
    const pilot = this.pilots.get(playerId);
    if (!pilot) return;
    pilot.dispose();
    this.pilots.delete(playerId);
    this.states.delete(playerId);
    this.prevShockBits.delete(playerId);
    this.prevJumpHeld.delete(playerId);
    this.bufferedJumps.delete(playerId);
    if (this.hostId === playerId) this.hostId = this.pickNewHost();
    this.broadcastAll(PlayerLeftMsg.encode({ playerId }));
    if (!this.isEmpty) this.lastNonEmptyAtMs = performance.now();
  }

  // Toggle a pilot's ready flag. The change shows up in the next snapshot.
  // Bots are always-ready and silently ignore the call.
  setReady(playerId: PlayerId, ready: boolean): void {
    const pilot = this.pilots.get(playerId);
    if (!pilot || pilot.isBot) return;
    pilot.ready = ready;
    const state = this.states.get(playerId);
    if (state) this.states.set(playerId, { ...state, ready });
  }

  // Host-only: transition the room into 'playing' phase. Idempotent — calling
  // again while already playing is a no-op. We don't require all humans ready
  // (host may want to start with some still flipping the toggle); the host
  // has the final word.
  startGame(playerId: PlayerId): boolean {
    if (this.phase !== 'lobby') return false;
    if (playerId !== this.hostId) return false;
    this.phase = 'playing';
    // Resolve the (possibly host-changed) runId into a RunDef and reset the
    // walk to stage 0 / phase 0. Falling back to the default protects
    // against a stale-but-non-empty runId reaching this point if validation
    // ever slips upstream.
    this.run = getRunOrDefault(this.runId);
    this.currentStageIndex = 0;
    this.currentPhaseIndex = 0;
    this.phaseElapsedS = 0;
    this.tiles = allocateTiles(this.grid.cols, this.grid.rows);
    // Clear residual fractional damage from any prior run; otherwise tile 0
    // could carry up to ~1 hp of leftover sub-integer damage into tick 1 of
    // the new run. Allocation is reused when grid size matches.
    this.damageAccum.fill(0);
    this.crawlers.clear();
    this.crawlerAi.clear();
    this.nextCrawlerId = 0;
    this.crawlerSpawnAccum = 0;
    this.carbons.clear();
    this.nextCarbonId = 0;
    // Drop any stale rising-edge state from the lobby — no shocks fire there
    // anyway, but resetting keeps the contract clean and prevents a stuck
    // "held" bit from suppressing the first in-game tap. Same story for the
    // panel-jump falling-edge tracker.
    this.prevShockBits.clear();
    this.prevJumpHeld.clear();
    this.bufferedJumps.clear();
    // Re-centre all players on the active stage's grid. Pre-game they sat
    // at spawn positions sized to whatever grid was active at join time,
    // which can be wrong if the host swapped runs mid-lobby.
    this.respawnAllOnCurrentGrid();
    return true;
  }

  private respawnAllOnCurrentGrid(): void {
    let slot = 0;
    for (const [id, state] of this.states) {
      const { x, y } = spawnPosition(this.grid, slot++);
      this.states.set(id, { ...state, x, y });
    }
  }

  // Advance the phase clock to the next phase. Public so future gameplay
  // code can drive event-driven phases (PhaseDef.durationS === null).
  // Called internally each tick when a timed phase elapses.
  advancePhase(): void {
    if (this.phase !== 'playing') return;
    const stage = getStage(this.run.stageSequence[this.currentStageIndex]!);
    const nextPhaseIndex = this.currentPhaseIndex + 1;
    if (nextPhaseIndex >= stage.phaseSequence.length) {
      this.advanceStage();
      return;
    }
    this.currentPhaseIndex = nextPhaseIndex;
    this.phaseElapsedS = 0;
  }

  private advanceStage(): void {
    const nextStageIndex = this.currentStageIndex + 1;
    if (nextStageIndex >= this.run.stageSequence.length) {
      this.phase = 'run-end';
      this.phaseElapsedS = 0;
      return;
    }
    this.currentStageIndex = nextStageIndex;
    this.currentPhaseIndex = 0;
    this.phaseElapsedS = 0;
    // Re-centre players on the new stage's grid so a smaller arena doesn't
    // strand someone outside the bounds.
    this.respawnAllOnCurrentGrid();
    this.tiles = allocateTiles(this.grid.cols, this.grid.rows);
  }

  // Host-only stress-test command. Spawns or removes NPCs to reach the
  // target count, clamped to MAX_NPCS_PER_ROOM. Returns the resulting
  // count.
  setNpcCount(playerId: PlayerId, target: number): number {
    if (playerId !== this.hostId) return this.npcs.size;
    const clamped = Math.max(0, Math.min(MAX_NPCS_PER_ROOM, Math.floor(target)));
    while (this.npcs.size < clamped) {
      const id = this.nextNpcId++ & 0xffff;
      // Skip ids that wrapped onto a still-live NPC (extremely unlikely
      // at the 1024 cap, but keeps the invariant tight).
      if (this.npcs.has(id)) continue;
      const w = this.grid.cols * this.grid.panelSize;
      const h = this.grid.rows * this.grid.panelSize;
      const x = Math.random() * w;
      const y = Math.random() * h;
      this.npcs.set(id, new Npc(id, x, y));
    }
    if (this.npcs.size > clamped) {
      // Drop the oldest ids first; predictable for tests.
      const ids = Array.from(this.npcs.keys()).sort((a, b) => a - b);
      const remove = this.npcs.size - clamped;
      for (let i = 0; i < remove; i++) this.npcs.delete(ids[i]!);
    }
    return this.npcs.size;
  }

  // Host-only: update run + difficulty selection. Both are validated
  // against the shared lists; invalid values silently leave the previous
  // selection untouched (the wire format is too lossy to round-trip an
  // error code, and the client driving this should be sending valid
  // values from a dropdown anyway). Returns true if anything changed.
  setLobbySettings(playerId: PlayerId, runId: string, difficulty: number): boolean {
    if (this.phase !== 'lobby') return false;
    if (playerId !== this.hostId) return false;
    let changed = false;
    if (isValidRunId(runId) && runId !== this.runId) {
      this.runId = runId;
      // Refresh the active RunDef + reset to stage 0 so the lobby preview
      // (e.g. grid getter) reflects the new run's first stage immediately.
      this.run = getRun(runId);
      this.currentStageIndex = 0;
      this.currentPhaseIndex = 0;
      this.phaseElapsedS = 0;
      this.tiles = allocateTiles(this.grid.cols, this.grid.rows);
      changed = true;
    }
    if (isValidDifficulty(difficulty) && difficulty !== this.difficulty) {
      this.difficulty = difficulty;
      changed = true;
    }
    return changed;
  }

  rejectJoin(conn: Connection, code: number, message: string): void {
    conn.send(ErrorMsg.encode({ code, message }));
    conn.close(1008, message);
  }

  private attach(playerId: PlayerId, pilot: Pilot, state: PlayerState): void {
    this.pilots.set(playerId, pilot);
    this.states.set(playerId, state);
    if (!this.isEmpty) this.lastNonEmptyAtMs = performance.now();
  }

  private pickNewHost(): PlayerId {
    // Lowest-id human wins. Deterministic and simple — by the time host left,
    // someone else has presumably been here a while.
    let best: PlayerId = NO_HOST;
    for (const [id, p] of this.pilots) {
      if (p.isBot) continue;
      if (best === NO_HOST || id < best) best = id;
    }
    return best;
  }

  private allocPlayerId(): PlayerId {
    // 0..254; reuse freed slots. 0xff is reserved as the NO_HOST sentinel.
    for (let i = 0; i < 255; i++) {
      const candidate = (this.nextPlayerId + i) & 0xfe;
      if (!this.pilots.has(candidate)) {
        this.nextPlayerId = (candidate + 1) & 0xfe;
        return candidate;
      }
    }
    throw new Error('No player id slot available');
  }

  private makeSpawnState(id: PlayerId, name: string): PlayerState {
    const slot = this.pilots.size;
    const { x, y } = spawnPosition(this.grid, slot);
    return newPlayerState(id, x, y, name);
  }

  private sendWelcome(conn: Connection): void {
    conn.send(
      WelcomeMsg.encode({
        yourPlayerId: conn.playerId,
        grid: this.grid,
        startTick: this.tick,
        serverTimeMs: Date.now(),
        phase: this.phase,
        hostId: this.hostId,
        difficulty: this.difficulty,
        runId: this.runId,
        currentStageIndex: this.currentStageIndex,
        currentPhaseIndex: this.currentPhaseIndex,
        phaseElapsedS: this.phaseElapsedS,
        maxPlayers: this.maxPlayers,
        sessionKey: conn.sessionKey,
        players: Array.from(this.states.values()),
        tiles: this.tiles,
      }),
    );
  }

  // --- Broadcast helpers ---

  private broadcastAll(bytes: Uint8Array): void {
    for (const p of this.pilots.values()) p.send(bytes);
  }
  private broadcastExcept(except: PlayerId, bytes: Uint8Array): void {
    for (const [id, p] of this.pilots) {
      if (id !== except) p.send(bytes);
    }
  }

  // --- Tick loop ---

  private scheduleNext(): void {
    if (!this.running) return;
    const now = performance.now();
    const nextPhysics = this.lastPhysicsAtMs + SERVER_TICK_DT_MS;
    const nextSnapshot = this.lastSnapshotAtMs + SERVER_SNAPSHOT_INTERVAL_MS;
    const next = Math.min(nextPhysics, nextSnapshot);
    const delay = Math.max(SCHEDULER_GRANULARITY_MS, next - now);
    this.timer = setTimeout(this.driveTick, delay);
  }

  private driveTick = (): void => {
    if (!this.running) return;
    const now = performance.now();

    // Catch up physics with a hard cap (anti-spiral).
    // In lobby phase we skip the actual sim step but still advance tick
    // counters — clients use predictedTick for input lead even in lobby
    // (so a panel-jump on the start frame doesn't get mis-targeted), and
    // ackInputTick bookkeeping needs to keep moving.
    let catchups = 0;
    while (
      now - this.lastPhysicsAtMs >= SERVER_TICK_DT_MS &&
      catchups < MAX_CATCHUP_PHYSICS_TICKS
    ) {
      this.lastPhysicsAtMs += SERVER_TICK_DT_MS;
      this.tick++;
      if (this.phase === 'playing') this.physicsStep();
      else this.lobbyStep();
      catchups++;
    }
    if (now - this.lastPhysicsAtMs > SERVER_TICK_DT_MS) {
      // Still behind after max catch-up — fast-forward without sim.
      this.lastPhysicsAtMs = now;
    }

    // Snapshot at its own cadence; never spiral.
    if (now - this.lastSnapshotAtMs >= SERVER_SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotAtMs += SERVER_SNAPSHOT_INTERVAL_MS;
      if (now - this.lastSnapshotAtMs > SERVER_SNAPSHOT_INTERVAL_MS) {
        this.lastSnapshotAtMs = now;
      }
      this.broadcastSnapshot();
    }

    if (!this.isEmpty) this.lastNonEmptyAtMs = now;
    this.scheduleNext();
  };

  private spawnCrawler(): void {
    if (this.crawlers.size >= MAX_ALIVE_CRAWLERS) return;
    const { cols, rows, panelSize } = this.grid;
    // Spawn just outside a random edge of the map. C1.2 AI retargets each
    // tick to the nearest pilot, so we no longer pick a fixed edge tile —
    // the bug picks its first target the moment it's stepped.
    const edge = Math.floor(Math.random() * 4);
    let x: number, y: number, facing: number, cx: number, cy: number;
    if (edge === 0) {
      cx = Math.floor(Math.random() * cols);
      cy = 0;
      x = cx * panelSize + panelSize / 2;
      y = -panelSize / 2;
      facing = Math.PI / 2;
    } else if (edge === 1) {
      cx = cols - 1;
      cy = Math.floor(Math.random() * rows);
      x = cols * panelSize + panelSize / 2;
      y = cy * panelSize + panelSize / 2;
      facing = Math.PI;
    } else if (edge === 2) {
      cx = Math.floor(Math.random() * cols);
      cy = rows - 1;
      x = cx * panelSize + panelSize / 2;
      y = rows * panelSize + panelSize / 2;
      facing = -Math.PI / 2;
    } else {
      cx = 0;
      cy = Math.floor(Math.random() * rows);
      x = -panelSize / 2;
      y = cy * panelSize + panelSize / 2;
      facing = 0;
    }
    const id = this.nextCrawlerId++ & 0xffff;
    this.crawlers.set(id, {
      id, x, y, facing, hp: 1,
      targetCx: cx, targetCy: cy,
      ai: CrawlerAIState.APPROACHING,
      windUpInS: 0,
    });
    // Pre-register with the priority-AI manager so per-bug AI state
    // exists from tick 0 (no implicit lazy creation in decide()). Profile
    // defaults to MITE_PROFILE — future enemy types will pass their own.
    this.crawlerAi.registerCrawler(id);
  }

  spawnCarbon(x: number, y: number): void {
    const id = this.nextCarbonId++ & 0xffff;
    this.carbons.set(id, { id, x, y, ttlS: CARBON_TTL_S });
  }

  // C1.2 hold-charge shock. Rising-edge tap is retired. The bit is held
  // ("LMB / F is down") while charging; on falling edge the beam fires.
  //
  // Beam length scales with shockHeldS: 0s → 1 tile, full charge → MAX tiles.
  // The beam is ray-marched at the cursor angle (true 360°, not cardinal-
  // snapped). Each conductive tile the ray crosses is electrified for
  // SHOCK_LINGER_TICKS server ticks; bugs on those tiles die at the moment
  // of fire, and any bug that wanders onto a still-charged tile during the
  // linger window dies in the per-tick sweep (see physicsStep).
  //
  // Non-conductive tiles in the path break the beam — propagation stops at
  // the first dead tile, matching the legacy "DAMAGED blocks shock" rule.
  // Returns a new PlayerState with shockCooldownS bumped, or the input state
  // unchanged if the beam length resolves to zero (e.g. negative tile count).
  private applyShockBeam(
    _playerId: PlayerId,
    playerState: PlayerState,
    input: PlayerInput,
  ): PlayerState {
    const trace = traceShockBeam(playerState, input, this.tiles, this.grid);
    for (const hit of trace.hits) {
      if (hit.conductive) {
        // Live panel: electrify for SHOCK_LINGER_TICKS, plus the beam +
        // tile-shock combined damage to bugs caught in the line.
        this.tiles.l1Charge[hit.idx] = SHOCK_LINGER_TICKS;
        this.damageCrawlersOnTile(hit.tx, hit.ty, SHOCK_BEAM_DAMAGE + SHOCK_TILE_DAMAGE);
      } else {
        // Impact tile (dead / damaged below conduction threshold): beam still
        // hits bugs standing on it, but propagation stops here.
        this.damageCrawlersOnTile(hit.tx, hit.ty, SHOCK_BEAM_DAMAGE);
      }
    }
    // Cooldown is consumed even on a wholly-missed shot — a fired weapon is
    // a fired weapon. Tap vs charged cooldown derived from charge ratio,
    // which traceShockBeam picks based on shockHeldS.
    return { ...playerState, shockCooldownS: trace.cooldownS };
  }

  // Damage every crawler whose centre lies on tile (tx,ty). Bugs that drop
  // to 0 HP are reaped (spawn carbon + clear AI state). C1.7 generalised
  // the old kill-all-on-tile to a damage value so beam vs. linger can
  // produce different effects for tougher future enemies.
  private damageCrawlersOnTile(tx: number, ty: number, amount: number): void {
    if (amount <= 0) return;
    const { panelSize } = this.grid;
    const tileMinX = tx * panelSize;
    const tileMinY = ty * panelSize;
    const tileMaxX = tileMinX + panelSize;
    const tileMaxY = tileMinY + panelSize;
    for (const [cid, c] of this.crawlers) {
      if (c.x >= tileMinX && c.x < tileMaxX && c.y >= tileMinY && c.y < tileMaxY) {
        const newHp = Math.max(0, c.hp - amount);
        if (newHp === 0) {
          this.spawnCarbon(c.x, c.y);
          this.crawlers.delete(cid);
          this.crawlerAi.remove(cid);
        } else {
          this.crawlers.set(cid, { ...c, hp: newHp });
        }
      }
    }
  }

  private physicsStep(): void {
    for (const [id, state] of this.states) {
      const pilot = this.pilots.get(id);
      const input = pilot ? pilot.consumeInputForTick(this.tick) : null;
      const next = stepPlayer(state, input, SERVER_TICK_DT_S, this.grid);
      // Shock — C1.2 hold-charge model. The bit is held while charging; on
      // falling edge the beam fires. Beam length scales with shockHeldS
      // (see applyShockBeam). Rising-edge tap is retired.
      // While held we accumulate dt into shockHeldS, saturating at
      // SHOCK_CHARGE_FULL_S so the wire-quantized timer never overshoots.
      let cur = next;
      const prevShockHeld = this.prevShockBits.get(id) ?? false;
      const shockHeldNow = !!(input && input.shock);
      this.prevShockBits.set(id, shockHeldNow);
      const fallingEdge = !shockHeldNow && prevShockHeld;
      if (shockHeldNow) {
        cur = {
          ...cur,
          shockHeldS: Math.min(SHOCK_CHARGE_FULL_S, cur.shockHeldS + SERVER_TICK_DT_S),
        };
      }
      if (fallingEdge) {
        if (input && cur.shockCooldownS === 0) {
          cur = this.applyShockBeam(id, cur, input);
        }
        cur = { ...cur, shockHeldS: 0 };
      } else if (cur.shockCooldownS > 0) {
        cur = { ...cur, shockCooldownS: Math.max(0, cur.shockCooldownS - SERVER_TICK_DT_S) };
      }
      // Repair (raise L1 panel HP back to max). TODO: this is the B1-style
      // "valid target = L1 is the topmost layer and below max HP" check,
      // approximating the legacy "DAMAGED" trinary state. Task 10+ may
      // refine the eligibility predicate and the HP scaling (e.g. partial
      // restore, multi-tick ramp, or L2 add-on rebuild path).
      if (input && input.repair && cur.carbon > 0) {
        const cx = Math.floor(cur.x / this.grid.panelSize);
        const cy = Math.floor(cur.y / this.grid.panelSize);
        if (cx >= 0 && cx < this.grid.cols && cy >= 0 && cy < this.grid.rows) {
          const idx = indexOf(this.grid.cols, cx, cy);
          const top = topmostLayer(this.tiles, idx);
          // Valid repair target = L1 is currently the topmost (no L2 addon,
          // L1 still present) AND it's below max HP.
          const repairable =
            top === LayerKind.L1_PANEL && this.tiles.l1Hp[idx]! < L1_PANEL_MAX_HP;
          if (repairable) {
            const newProgress = cur.repairProgressS + SERVER_TICK_DT_S;
            if (newProgress >= REPAIR_DURATION_S) {
              this.tiles.l1Hp[idx] = L1_PANEL_MAX_HP;
              cur = { ...cur, carbon: cur.carbon - REPAIR_CARBON_COST, repairProgressS: 0 };
            } else {
              cur = { ...cur, repairProgressS: newProgress };
            }
          } else {
            // Not on a repairable tile; reset progress.
            cur = { ...cur, repairProgressS: 0 };
          }
        }
      } else {
        // Input not held OR no carbon — reset.
        cur = { ...cur, repairProgressS: 0 };
      }
      // Panel-jump (Task 13, updated in C1.4 with input buffering). The
      // shared `tryPanelJump` helper handles falling-edge detection AND a
      // one-slot buffer: a release during cooldown stashes the (dx, dy) and
      // fires it the moment cooldown drains. Same code path runs client-side
      // so chains stay smooth.
      const prevHeld = this.prevJumpHeld.get(id) ?? false;
      const heldNow = !!(input && input.jumpHeld);
      this.prevJumpHeld.set(id, heldNow);
      if (input) {
        const prevBuf = this.bufferedJumps.get(id) ?? null;
        const result = tryPanelJump(cur, input, prevHeld, prevBuf, this.tiles, this.grid);
        cur = result.state;
        if (result.buffered) this.bufferedJumps.set(id, result.buffered);
        else this.bufferedJumps.delete(id);
      }
      this.states.set(id, cur);
    }
    if (this.npcs.size > 0) {
      for (const npc of this.npcs.values()) {
        npc.step(SERVER_TICK_DT_S, this.tick, this.grid);
      }
    }

    // B1 Crawler spawner — continuous trickle while playing.
    this.crawlerSpawnAccum += SERVER_TICK_DT_S;
    if (this.crawlerSpawnAccum >= CRAWLER_SPAWN_INTERVAL_S) {
      this.crawlerSpawnAccum -= CRAWLER_SPAWN_INTERVAL_S;
      this.spawnCrawler();
    }

    // Step all crawlers. The priority-AI decides what each bug is doing
    // (chase / attack tile) — stepCrawler is just the executor. We snapshot
    // players + bugs into arrays because `Map.values()` is a one-shot
    // iterator; passing it through multiple AI calls would silently empty
    // after the first crawler. The bug snapshot also gives the AI a stable
    // crowd-radius lookup as it iterates (each bug sees its peers at the
    // start-of-tick positions, not interleaved partial updates).
    const playerArr = Array.from(this.states.values());
    const bugArr = Array.from(this.crawlers.values());
    const ctx: CrawlerStepContext = { tiles: this.tiles };
    for (const [id, c] of this.crawlers) {
      const task = this.crawlerAi.decide(c, SERVER_TICK_DT_S, playerArr, bugArr, this.tiles, this.grid);
      const next = stepCrawler(c, task, SERVER_TICK_DT_S, this.grid, ctx);
      if (next.hp <= 0) {
        this.crawlers.delete(id);
        this.crawlerAi.remove(id);
      } else {
        this.crawlers.set(id, next);
      }
    }

    // Lingering electricity sweep: kill bugs standing on charged tiles, then
    // tick down each tile's charge counter. Done AFTER stepCrawler so bugs
    // that walked into a charged tile this tick still get fried.
    this.applyShockLinger();

    // Weight-driven integrity damage: each ATTACKING crawler contributes
    // CRAWLER_WEIGHT to its target tile. Runs after the linger sweep so dead
    // bugs are already removed.
    this.applyWeightIntegrity(SERVER_TICK_DT_S);

    // Carbon expiry + pickup. Combat kills (Task 10) call spawnCarbon directly.
    for (const [id, carbon] of this.carbons) {
      const nextTtl = carbon.ttlS - SERVER_TICK_DT_S;
      if (nextTtl <= 0) {
        this.carbons.delete(id);
        continue;
      }
      // Pickup: any player within (PLAYER_RADIUS + CARBON_PICKUP_RADIUS) collects it.
      let pickedUp = false;
      for (const [pid, pstate] of this.states) {
        const dist = Math.hypot(carbon.x - pstate.x, carbon.y - pstate.y);
        if (dist <= PLAYER_RADIUS + CARBON_PICKUP_RADIUS) {
          const newCarbon = Math.min(PLAYER_CARBON_MAX, pstate.carbon + 1);
          this.states.set(pid, { ...pstate, carbon: newCarbon });
          this.carbons.delete(id);
          pickedUp = true;
          break;
        }
      }
      if (!pickedUp) {
        this.carbons.set(id, { ...carbon, ttlS: nextTtl });
      }
    }

    // Phase clock. Open-ended phases (durationS === null) wait for an
    // explicit advancePhase() call from gameplay code.
    this.phaseElapsedS += SERVER_TICK_DT_S;
    const cur = this.currentPhaseDef();
    if (cur.durationS !== null && this.phaseElapsedS >= cur.durationS) {
      this.advancePhase();
    }
  }

  // Per-tick lingering-electricity sweep. Any bug standing on a charged tile
  // (l1Charge > 0) takes SHOCK_TILE_DAMAGE; bugs that drop to 0 HP are reaped
  // and drop carbon. After the damage pass, every tile's charge counter
  // decrements by one tick. This is what makes long-charge beams meaningful:
  // bugs that wander onto a recently-electrified tile keep getting shocked.
  private applyShockLinger(): void {
    const { cols, panelSize } = this.grid;
    for (const [cid, c] of this.crawlers) {
      const tcx = Math.floor(c.x / panelSize);
      const tcy = Math.floor(c.y / panelSize);
      if (tcx < 0 || tcx >= cols || tcy < 0) continue;
      const idx = indexOf(cols, tcx, tcy);
      if (idx >= this.tiles.l1Charge.length) continue;
      if (this.tiles.l1Charge[idx]! > 0) {
        const newHp = Math.max(0, c.hp - SHOCK_TILE_DAMAGE);
        if (newHp === 0) {
          this.spawnCarbon(c.x, c.y);
          this.crawlers.delete(cid);
          this.crawlerAi.remove(cid);
        } else {
          this.crawlers.set(cid, { ...c, hp: newHp });
        }
      }
    }
    // Then decrement charge counters.
    const charges = this.tiles.l1Charge;
    for (let i = 0; i < charges.length; i++) {
      if (charges[i]! > 0) charges[i] = charges[i]! - 1;
    }
  }

  // Per-tick weight aggregation + integrity damage pass. Only ATTACKING
  // crawlers contribute weight (APPROACHING haven't arrived; TRANSITING are
  // leaving). Each tile takes damage proportional to its own load — bugs
  // damage only the tile they're attacking, not its 4-cardinal neighbours.
  // (The neighbour-spread variant felt buggy in playtest: one crawler left a
  // trail of partially damaged tiles before fully destroying its target.)
  // Stacking weight still hits the quadratic regime above WEIGHT_THRESHOLD,
  // so swarms collapse a tile much faster than singletons.
  // Damage = damagePerSecond(load, armor) × dt → topmost layer. Armor is 0
  // for L0/L1 in C1; the L2 add-on armor table arrives in a later task.
  private applyWeightIntegrity(dt: number): void {
    const cols = this.grid.cols;
    const rows = this.grid.rows;
    const n = cols * rows;
    // Resize the accumulator if the active grid changed (stage swap, etc.).
    if (this.damageAccum.length !== n) {
      this.damageAccum = new Float32Array(n);
    }
    const weightAt = new Uint16Array(n);
    for (const c of this.crawlers.values()) {
      // C1.4: only ATTACKING bugs contribute weight. The priority-AI
      // distinguishes "chasing the player" from "biting a tile" — chasing
      // walks fast and does NOT damage tiles in transit (per user feedback).
      if (c.ai !== CrawlerAIState.ATTACKING) continue;
      if (
        c.targetCx < 0 || c.targetCx >= cols ||
        c.targetCy < 0 || c.targetCy >= rows
      ) {
        continue;
      }
      const px = Math.floor(c.x / this.grid.panelSize);
      const py = Math.floor(c.y / this.grid.panelSize);
      if (px < 0 || px >= cols || py < 0 || py >= rows) continue;
      weightAt[indexOf(cols, c.targetCx, c.targetCy)]! += CRAWLER_WEIGHT;
    }
    for (let i = 0; i < n; i++) {
      const w = weightAt[i]!;
      if (w === 0) continue;
      const top = topmostLayer(this.tiles, i);
      if (top === null) continue;
      // Armor is 0 for L0/L1 in C1 (L2 addon catalog with armor lands later).
      const dps = damagePerSecond(w, 0);
      // The tile hp buffers are Uint8 — assigning fractional damage would
      // truncate ~0.067 hp to 1 hp each tick, grossly over-damaging. Buffer
      // sub-integer damage in damageAccum and only flush whole hp once it
      // crosses 1.0.
      const acc = this.damageAccum[i]! + dps * dt;
      const whole = Math.floor(acc);
      this.damageAccum[i] = acc - whole;
      if (whole > 0) damageTopmost(this.tiles, i, whole);
    }
  }

  // Lobby tick: drain inputs to keep ackInputTick advancing (so client-side
  // RTT bookkeeping doesn't stall) but never advance the sim. Players sit
  // at their spawn until phase flips to 'playing'.
  private lobbyStep(): void {
    for (const pilot of this.pilots.values()) {
      pilot.consumeInputForTick(this.tick);
    }
  }

  private broadcastSnapshot(): void {
    const players = Array.from(this.states.values());
    // Encoder reads .state directly off each Npc instance, so building a
    // fresh array of refs is one allocation per snapshot regardless of
    // count. We avoid copying NpcState objects.
    const npcStates: NpcState[] = [];
    if (this.npcs.size > 0) {
      for (const npc of this.npcs.values()) npcStates.push(npc.state);
    }
    const serverTimeMs = Date.now();
    for (const pilot of this.pilots.values()) {
      // AOI hook (Phase 0: identity). When per-client culling ships, this
      // returns a per-pilot subset and we move encoding here-per-pilot.
      const visible = this.aoiFilter(pilot, players);
      const bytes = SnapshotMsg.encode({
        tick: this.tick,
        serverTimeMs,
        ackInputTick: pilot.ackInputTick,
        inputAckBitmask: pilot.computeAckBitmask(),
        phase: this.phase,
        hostId: this.hostId,
        difficulty: this.difficulty,
        runId: this.runId,
        currentStageIndex: this.currentStageIndex,
        currentPhaseIndex: this.currentPhaseIndex,
        phaseElapsedS: this.phaseElapsedS,
        tiles: this.tiles,
        players: visible,
        npcs: npcStates,
        crawlers: Array.from(this.crawlers.values()),
        carbons: Array.from(this.carbons.values()),
      });
      // Snapshots are loss-tolerant: a newer one supersedes any in flight.
      // Route via the unreliable channel so high-latency clients aren't
      // stuck behind TCP retransmits of stale state when we have RTC up.
      pilot.send(bytes, 'unreliable');
    }
  }

  // Stub: no culling yet.
  private aoiFilter(_pilot: Pilot, all: PlayerState[]): PlayerState[] {
    return all;
  }
}
