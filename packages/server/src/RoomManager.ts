import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@gridforce/shared';
import { Room } from './Room.js';

export class RoomManager {
  private rooms = new Map<string, Room>();
  private prunerHandle: NodeJS.Timeout;

  constructor() {
    this.prunerHandle = setInterval(() => this.pruneEmpty(), 5_000);
    // Allow process to exit while interval is alive (only if needed)
    if (typeof this.prunerHandle.unref === 'function') this.prunerHandle.unref();
  }

  get size(): number {
    return this.rooms.size;
  }

  createRoom(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = generateCode();
      if (!this.rooms.has(code)) {
        const room = new Room(code, () => this.rooms.delete(code));
        this.rooms.set(code, room);
        return code;
      }
    }
    throw new Error('Failed to allocate unique room code');
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  getOrCreate(code: string): Room {
    const upper = code.toUpperCase();
    let room = this.rooms.get(upper);
    if (!room) {
      room = new Room(upper, () => this.rooms.delete(upper));
      this.rooms.set(upper, room);
    }
    return room;
  }

  private pruneEmpty(): void {
    for (const [code, room] of this.rooms) {
      if (room.shouldPrune()) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }
}

function generateCode(): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    out += ROOM_CODE_ALPHABET[idx];
  }
  return out;
}
