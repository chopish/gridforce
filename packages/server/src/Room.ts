import {
  DEFAULT_GRID_H,
  DEFAULT_GRID_W,
  MAX_PLAYERS_PER_ROOM,
  TICK_DT_MS,
  TICK_DT_S,
  createGrid,
  createPlayer,
  gridPixelHeight,
  gridPixelWidth,
  pickSpawn,
  simulate,
  type Player,
  type PlayerInput,
  type WorldState,
} from '@gridforce/shared';
import type { Bot } from './bots/Bot.js';
import { IdleBot } from './bots/IdleBot.js';
import { Connection } from './Connection.js';

let nextBotId = 1;

export class Room {
  readonly code: string;
  readonly capacity = MAX_PLAYERS_PER_ROOM;
  private state: WorldState;
  private connections = new Map<string, Connection>();
  private bots: Bot[] = [];
  private tickHandle: NodeJS.Timeout | null = null;
  private tickStopped = false;
  private startedAt = Date.now();
  private lastActivityAt = Date.now();
  private onDisposed: () => void;
  // Maximum sub-ticks per real-time frame when catching up from a stall.
  // Generous so transient client bursts (browser frame stalls produce 3-6
  // inputs in a single rAF) drain in one server tick instead of accumulating.
  private static readonly MAX_CATCHUP = 8;

  constructor(code: string, onDisposed: () => void) {
    this.code = code;
    this.onDisposed = onDisposed;
    const grid = createGrid(DEFAULT_GRID_W, DEFAULT_GRID_H);
    this.state = {
      tick: 0,
      grid,
      players: [],
      rngState: hashCodeToInt(code),
    };
    this.startTickLoop();
  }

  get worldState(): WorldState {
    return this.state;
  }

  get population(): number {
    return this.connections.size + this.bots.length;
  }

  shouldPrune(): boolean {
    return this.connections.size === 0 && Date.now() - this.lastActivityAt > 60_000;
  }

  getPlayerSummaries(): Array<{ id: string; name: string; isBot: boolean }> {
    return this.state.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot }));
  }

  addConnection(conn: Connection): { success: true } | { success: false; reason: 'ROOM_FULL' } {
    if (this.population >= this.capacity) {
      return { success: false, reason: 'ROOM_FULL' };
    }

    const worldW = gridPixelWidth(this.state.grid);
    const worldH = gridPixelHeight(this.state.grid);
    const spawn = pickSpawn(worldW, worldH, this.state.players);
    const player = createPlayer(conn.playerId, conn.name, false, spawn.x, spawn.y);

    this.state = { ...this.state, players: [...this.state.players, player] };
    this.connections.set(conn.playerId, conn);
    this.lastActivityAt = Date.now();

    // Send Welcome with full grid + immediate snapshot
    conn.send({
      type: 'welcome',
      playerId: conn.playerId,
      roomCode: this.code,
      grid: this.state.grid,
      snapshot: this.makeSnapshot(conn),
    });

    // Notify other connections
    this.broadcastExcept(conn.playerId, { type: 'playerJoined', player });

    return { success: true };
  }

  removeConnection(playerId: string): void {
    if (!this.connections.has(playerId)) return;
    this.connections.delete(playerId);
    this.state = {
      ...this.state,
      players: this.state.players.filter((p) => p.id !== playerId),
    };
    this.broadcastAll({ type: 'playerLeft', playerId });
    this.lastActivityAt = Date.now();
  }

  addBot(): Bot | null {
    if (this.population >= this.capacity) return null;
    const id = `bot-${nextBotId++}`;
    const bot = new IdleBot(id, `Bot ${id.slice(4)}`);
    this.bots.push(bot);

    const worldW = gridPixelWidth(this.state.grid);
    const worldH = gridPixelHeight(this.state.grid);
    const spawn = pickSpawn(worldW, worldH, this.state.players);
    const botPlayer = createPlayer(bot.id, bot.name, true, spawn.x, spawn.y);
    this.state = { ...this.state, players: [...this.state.players, botPlayer] };
    this.broadcastAll({ type: 'playerJoined', player: botPlayer });
    return bot;
  }

  ingestInput(playerId: string, input: PlayerInput): void {
    const conn = this.connections.get(playerId);
    if (!conn) return;
    conn.bufferInput(input);
    this.lastActivityAt = Date.now();
  }

  dispose(): void {
    this.tickStopped = true;
    if (this.tickHandle) {
      clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.bots = [];
    this.onDisposed();
  }

  // ---------- private ----------

  private startTickLoop(): void {
    // Self-correcting setTimeout loop. Node's setInterval is bound by the OS
    // timer quantum (15.6 ms on Windows by default), which makes a 16.67 ms
    // target effectively run at ~50 Hz. We track an absolute "next tick at"
    // time and adjust each setTimeout delay to compensate, so the average
    // rate stays at exactly 60 Hz even if individual fires drift.
    let nextAt = performance.now() + TICK_DT_MS;
    const loop = (): void => {
      if (this.tickStopped) return;
      this.tick();
      nextAt += TICK_DT_MS;
      const now = performance.now();
      let delay = nextAt - now;
      // If we've fallen catastrophically behind (e.g., long GC pause),
      // give up trying to catch up by spinning and reset the target.
      if (delay < -10 * TICK_DT_MS) {
        nextAt = now + TICK_DT_MS;
        delay = TICK_DT_MS;
      } else if (delay < 0) {
        delay = 0;
      }
      this.tickHandle = setTimeout(loop, delay);
    };
    this.tickHandle = setTimeout(loop, TICK_DT_MS);
  }

  // One real-time tick = one snapshot broadcast. May contain multiple
  // simulation sub-ticks if the server is catching up from a stall (a player's
  // input buffer has grown). Catch-up is capped to MAX_CATCHUP per frame so a
  // long pause can't lock the server into a CPU-burning replay.
  private tick(): void {
    let subTicks = 1;
    for (const conn of this.connections.values()) {
      const buffered = conn.bufferedInputCount();
      if (buffered > subTicks) subTicks = Math.min(Room.MAX_CATCHUP, buffered);
    }

    for (let i = 0; i < subTicks; i++) {
      this.runOneSubTick();
    }

    // One snapshot per real-time tick (not per sub-tick) to keep wire rate
    // stable. ackInputTick reflects the latest input applied across sub-ticks.
    for (const conn of this.connections.values()) {
      conn.send(this.makeSnapshot(conn));
    }
  }

  private runOneSubTick(): void {
    const inputs = new Map<string, PlayerInput>();

    for (const conn of this.connections.values()) {
      const next = conn.consumeNextInput();
      if (next) {
        inputs.set(conn.playerId, next);
      } else {
        // No buffered input: hold position with zero input. Tick label
        // doesn't matter for sim correctness; only the input fields do.
        inputs.set(conn.playerId, { tick: this.state.tick, mx: 0, my: 0, dash: false });
      }
    }

    for (const bot of this.bots) {
      inputs.set(bot.id, bot.getInput(this.state, this.state.tick));
    }

    this.state = simulate(this.state, inputs, TICK_DT_S);
  }

  private makeSnapshot(conn: Connection) {
    return {
      type: 'snapshot' as const,
      tick: this.state.tick,
      serverTime: Date.now(),
      players: this.state.players,
      ackInputTick: conn.lastAppliedInputTick,
    };
  }

  private broadcastAll(msg: Parameters<Connection['send']>[0]): void {
    for (const conn of this.connections.values()) conn.send(msg);
  }

  private broadcastExcept(playerId: string, msg: Parameters<Connection['send']>[0]): void {
    for (const conn of this.connections.values()) {
      if (conn.playerId !== playerId) conn.send(msg);
    }
  }
}

function hashCodeToInt(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) {
    h = (h * 31 + code.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
