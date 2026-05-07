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
  private startedAt = Date.now();
  private lastActivityAt = Date.now();
  private onDisposed: () => void;

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
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.bots = [];
    this.onDisposed();
  }

  // ---------- private ----------

  private startTickLoop(): void {
    this.tickHandle = setInterval(() => this.tick(), TICK_DT_MS);
  }

  private tick(): void {
    const inputs = new Map<string, PlayerInput>();

    for (const conn of this.connections.values()) {
      const input = conn.consumeInputForTick(this.state.tick);
      inputs.set(conn.playerId, input);
    }

    for (const bot of this.bots) {
      inputs.set(bot.id, bot.getInput(this.state, this.state.tick));
    }

    this.state = simulate(this.state, inputs, TICK_DT_S);

    // Broadcast snapshot (per-connection because ackInputTick differs per player)
    for (const conn of this.connections.values()) {
      conn.send(this.makeSnapshot(conn));
    }
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
