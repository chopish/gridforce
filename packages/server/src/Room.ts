import { performance } from 'node:perf_hooks';

import {
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
  newPlayerState,
  stepPlayer,
  type GridDef,
  type PlayerId,
  type PlayerState,
} from '@gridforce/shared';

import type { Connection } from './Connection.js';
import type { Pilot } from './Pilot.js';
import { WanderBot } from './bots/WanderBot.js';

const MAX_CATCHUP_PHYSICS_TICKS = 8;
const SCHEDULER_GRANULARITY_MS = 4; // never sleep finer than this

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
    this.attach(id, conn, this.makeSpawnState(id));
    this.broadcastExcept(id, PlayerJoinedMsg.encode({ player: this.states.get(id)! }));
    this.sendWelcome(conn);
  }

  addBot(): { ok: true; playerId: PlayerId } | { ok: false; code: number } {
    if (this.pilots.size >= this.maxPlayers) {
      return { ok: false, code: ErrorCode.RoomFull };
    }
    const id = this.allocPlayerId();
    const bot = new WanderBot(id);
    this.attach(id, bot, this.makeSpawnState(id));
    this.broadcastAll(PlayerJoinedMsg.encode({ player: this.states.get(id)! }));
    return { ok: true, playerId: id };
  }

  remove(playerId: PlayerId): void {
    const pilot = this.pilots.get(playerId);
    if (!pilot) return;
    pilot.dispose();
    this.pilots.delete(playerId);
    this.states.delete(playerId);
    this.broadcastAll(PlayerLeftMsg.encode({ playerId }));
    if (!this.isEmpty) this.lastNonEmptyAtMs = performance.now();
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

  private allocPlayerId(): PlayerId {
    // 0..255; reuse freed slots
    for (let i = 0; i < 256; i++) {
      const candidate = (this.nextPlayerId + i) & 0xff;
      if (!this.pilots.has(candidate)) {
        this.nextPlayerId = (candidate + 1) & 0xff;
        return candidate;
      }
    }
    throw new Error('No player id slot available');
  }

  private makeSpawnState(id: PlayerId): PlayerState {
    const slot = this.pilots.size;
    const { x, y } = spawnPosition(this.grid, slot);
    return newPlayerState(id, x, y);
  }

  private sendWelcome(conn: Connection): void {
    conn.send(
      WelcomeMsg.encode({
        yourPlayerId: conn.playerId,
        grid: this.grid,
        startTick: this.tick,
        serverTimeMs: Date.now(),
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
    let catchups = 0;
    while (now - this.lastPhysicsAtMs >= SERVER_TICK_DT_MS && catchups < MAX_CATCHUP_PHYSICS_TICKS) {
      this.lastPhysicsAtMs += SERVER_TICK_DT_MS;
      this.tick++;
      this.physicsStep();
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
  }

  private broadcastSnapshot(): void {
    const players = Array.from(this.states.values());
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
        players: visible,
      });
      pilot.send(bytes);
    }
  }

  // Stub: no culling yet.
  private aoiFilter(_pilot: Pilot, all: PlayerState[]): PlayerState[] {
    return all;
  }
}
