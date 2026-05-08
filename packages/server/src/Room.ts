import { performance } from 'node:perf_hooks';

import {
  DEFAULT_DIFFICULTY,
  DEFAULT_LEVEL_ID,
  ErrorCode,
  ErrorMsg,
  MAX_PLAYERS_PER_ROOM,
  PlayerJoinedMsg,
  PlayerLeftMsg,
  SERVER_SNAPSHOT_INTERVAL_MS,
  SERVER_TICK_DT_MS,
  SERVER_TICK_DT_S,
  SnapshotMsg,
  WelcomeMsg,
  createDefaultGrid,
  isValidDifficulty,
  isValidLevelId,
  newPlayerState,
  stepPlayer,
  type DifficultyValue,
  type GridDef,
  type NpcState,
  type PlayerId,
  type PlayerState,
  type RoomPhase,
} from '@gridforce/shared';

import type { Connection } from './Connection.js';
import { Npc } from './Npc.js';
import type { Pilot } from './Pilot.js';
import { WanderBot } from './bots/WanderBot.js';

const MAX_CATCHUP_PHYSICS_TICKS = 8;
const SCHEDULER_GRANULARITY_MS = 4; // never sleep finer than this
const NO_HOST: PlayerId = 0xff;
// Per-room ceiling on NPC count. Real cap will fall out of AOI + budget
// numbers later; for stress tests this is plenty headroom past Phase 0
// targets (300 entities) without letting a stuck client wedge the room
// into an OOM by spamming SetNpcCount(0xffff).
const MAX_NPCS_PER_ROOM = 1024;

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
  readonly grid: GridDef = createDefaultGrid();
  readonly pilots = new Map<PlayerId, Pilot>();
  readonly states = new Map<PlayerId, PlayerState>();

  readonly name: string;
  readonly visibility: RoomVisibility;
  readonly maxPlayers: number;
  readonly createdAtMs = performance.now();

  // 'lobby' on creation. Host transitions to 'playing' via StartGame, after
  // which physics steps run. New rooms always start in lobby — Phase 0 has
  // no concept of "rejoining a game in progress with no waiting room".
  phase: RoomPhase = 'lobby';
  // PlayerId of the human host, or NO_HOST (0xff) if there's no human in
  // the room. Bots cannot be host. Promotion happens automatically: first
  // human to join becomes host; on host leave the next human is promoted.
  hostId: PlayerId = NO_HOST;
  // Pre-game selections, settable from the lobby UI by the host. Defaults
  // are the only Phase 0 level + Normal difficulty.
  levelId: string = DEFAULT_LEVEL_ID;
  difficulty: DifficultyValue = DEFAULT_DIFFICULTY;
  // Wandering NPCs spawned by the host as a netcode stress test. Empty
  // by default — host opts in via SetNpcCount keybinds.
  readonly npcs = new Map<number, Npc>();
  private nextNpcId = 0;

  tick = 0;
  private nextPlayerId: PlayerId = 0;
  private startWallMs = 0;
  private lastPhysicsAtMs = 0;
  private lastSnapshotAtMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastNonEmptyAtMs = performance.now();

  constructor(public readonly code: string, opts: RoomOptions = {}) {
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
    if (this.phase === 'playing') return false;
    if (playerId !== this.hostId) return false;
    this.phase = 'playing';
    return true;
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

  // Host-only: update level + difficulty selection. Both are validated
  // against the shared lists; invalid values silently leave the previous
  // selection untouched (the wire format is too lossy to round-trip an
  // error code, and the client driving this should be sending valid
  // values from a dropdown anyway). Returns true if anything changed.
  setLobbySettings(playerId: PlayerId, levelId: string, difficulty: number): boolean {
    if (this.phase !== 'lobby') return false;
    if (playerId !== this.hostId) return false;
    let changed = false;
    if (isValidLevelId(levelId) && levelId !== this.levelId) {
      this.levelId = levelId;
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
        levelId: this.levelId,
        maxPlayers: this.maxPlayers,
        sessionKey: conn.sessionKey,
        players: Array.from(this.states.values()),
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
    // (so dash-on-start-frame doesn't get mis-targeted), and ackInputTick
    // bookkeeping needs to keep moving.
    let catchups = 0;
    while (now - this.lastPhysicsAtMs >= SERVER_TICK_DT_MS && catchups < MAX_CATCHUP_PHYSICS_TICKS) {
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

  private physicsStep(): void {
    for (const [id, state] of this.states) {
      const pilot = this.pilots.get(id);
      const input = pilot ? pilot.consumeInputForTick(this.tick) : null;
      const next = stepPlayer(state, input, SERVER_TICK_DT_S, this.grid);
      this.states.set(id, next);
    }
    if (this.npcs.size > 0) {
      for (const npc of this.npcs.values()) {
        npc.step(SERVER_TICK_DT_S, this.tick, this.grid);
      }
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
        levelId: this.levelId,
        players: visible,
        npcs: npcStates,
      });
      pilot.send(bytes);
    }
  }

  // Stub: no culling yet.
  private aoiFilter(_pilot: Pilot, all: PlayerState[]): PlayerState[] {
    return all;
  }
}
