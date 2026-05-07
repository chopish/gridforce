import { performance } from 'node:perf_hooks';

import { ROOM_CODE_LENGTH, ROOM_IDLE_PRUNE_MS } from '@gridforce/shared';

import { Room } from './Room.js';

// Avoid 0/O, 1/I/L confusion in spoken codes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]!;
  }
  return s;
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

  createRoom(): Room {
    let code: string;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    room.start();
    return room;
  }

  // Get-or-create. Empty room codes (or "" placeholder) create a new room.
  resolveRoom(code: string): Room {
    const k = code.trim().toUpperCase();
    if (k.length === 0) return this.createRoom();
    const existing = this.rooms.get(k);
    if (existing) return existing;
    // Honor whatever code the client supplied — they have a copy/share UX.
    const fresh = new Room(k);
    this.rooms.set(k, fresh);
    fresh.start();
    return fresh;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
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
