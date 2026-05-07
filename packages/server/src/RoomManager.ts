import { performance } from 'node:perf_hooks';

import { ROOM_CODE_LENGTH, ROOM_IDLE_PRUNE_MS } from '@gridforce/shared';

import { Room, type RoomOptions } from './Room.js';

// Avoid 0/O, 1/I/L confusion in spoken codes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]!;
  }
  return s;
}

export interface PublicRoomInfo {
  code: string;
  name: string;
  players: number;
  maxPlayers: number;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => this.pruneIdle(), 5_000);
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    for (const room of this.rooms.values()) room.stop();
    this.rooms.clear();
  }

  // Explicit creation. Always allocates a fresh code and applies the supplied
  // metadata. Use this for the HTTP create-room endpoint.
  createRoom(opts: RoomOptions = {}): Room {
    let code: string;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, opts);
    this.rooms.set(code, room);
    room.start();
    return room;
  }

  // Strict lookup. Returns undefined if no such room — does NOT auto-create.
  // Auto-creation is gone: rooms are only born via createRoom() so visibility
  // and invite policy can't be bypassed by guessing a code.
  findRoom(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  listPublic(): PublicRoomInfo[] {
    const out: PublicRoomInfo[] = [];
    for (const room of this.rooms.values()) {
      if (room.visibility !== 'public') continue;
      out.push({
        code: room.code,
        name: room.name,
        players: room.playerCount,
        maxPlayers: room.maxPlayers,
      });
    }
    return out;
  }

  private pruneIdle(): void {
    const now = performance.now();
    for (const [code, room] of this.rooms) {
      if (room.isEmpty && now - room.lastNonEmptyAt > ROOM_IDLE_PRUNE_MS) {
        room.stop();
        this.rooms.delete(code);
      }
    }
  }

  // Diagnostic.
  get roomCount(): number {
    return this.rooms.size;
  }
}
