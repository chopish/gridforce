import type { Grid, Player, PlayerInput } from './types.js';

// Wire messages. Both sides import from this file — single source of truth for the protocol.

// ---------- Client → Server ----------
export interface ClientHello {
  type: 'hello';
  roomCode: string;
  name: string;
  clientId: string;
}

export interface ClientInput {
  type: 'input';
  input: PlayerInput;
  clientTime: number;
}

export interface ClientPing {
  type: 'ping';
  clientTime: number;
}

export interface ClientAddBot {
  type: 'addBot';
}

export type ClientMessage = ClientHello | ClientInput | ClientPing | ClientAddBot;

// ---------- Server → Client ----------

export interface ServerWelcome {
  type: 'welcome';
  playerId: string;
  roomCode: string;
  grid: Grid;
  snapshot: ServerSnapshot;
}

export interface ServerSnapshot {
  type: 'snapshot';
  tick: number;
  serverTime: number;
  players: Player[];
  // The latest input tick the server has applied for THIS client.
  // Client uses it to drop acknowledged inputs from its replay buffer.
  ackInputTick: number;
}

export interface ServerPong {
  type: 'pong';
  clientTime: number;
  serverTime: number;
}

export interface ServerError {
  type: 'error';
  code: 'ROOM_FULL' | 'ROOM_NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL';
  message: string;
}

export interface ServerPlayerJoined {
  type: 'playerJoined';
  player: Player;
}

export interface ServerPlayerLeft {
  type: 'playerLeft';
  playerId: string;
}

export type ServerMessage =
  | ServerWelcome
  | ServerSnapshot
  | ServerPong
  | ServerError
  | ServerPlayerJoined
  | ServerPlayerLeft;

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T = ClientMessage | ServerMessage>(raw: string): T {
  return JSON.parse(raw) as T;
}
