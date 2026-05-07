import type { WebSocket } from 'ws';
import {
  encode,
  type PlayerInput,
  type ServerMessage,
} from '@gridforce/shared';

// Connection wraps a single WebSocket bound to one player in one room.
// It owns the player's input buffer (most-recent-wins, keyed by tick).
export class Connection {
  readonly playerId: string;
  readonly name: string;
  readonly socket: WebSocket;

  // Buffered inputs by tick. We keep a small history because the server
  // may need to apply an input for the tick the client INTENDED, which is
  // typically a tick or two ahead of where the server currently is when the
  // packet arrives.
  private inputBuffer = new Map<number, PlayerInput>();
  private latestInputTick = -1;

  // Last input tick the server actually applied; sent back on snapshots so the
  // client can drop acknowledged inputs from its replay buffer.
  lastAppliedInputTick = -1;

  alive = true;

  constructor(playerId: string, name: string, socket: WebSocket) {
    this.playerId = playerId;
    this.name = name;
    this.socket = socket;
  }

  bufferInput(input: PlayerInput): void {
    this.inputBuffer.set(input.tick, input);
    if (input.tick > this.latestInputTick) this.latestInputTick = input.tick;

    // Cap is generous — at 60 Hz this allows ~17 s of buffered inputs before
    // we start dropping oldest. Dropping oldest causes the server to skip
    // applying that input, which desyncs the player from client prediction.
    // We'd rather buffer more and let catch-up drain it.
    if (this.inputBuffer.size > 1024) {
      const oldestTick = Math.min(...this.inputBuffer.keys());
      this.inputBuffer.delete(oldestTick);
    }
  }

  // Number of inputs currently buffered (waiting to be consumed).
  bufferedInputCount(): number {
    return this.inputBuffer.size;
  }

  // Returns the next unapplied input in tick order, or null if none.
  // The server calls this once per server sub-tick per player so EACH input
  // the client sent gets applied exactly once. Without this, fast-arriving
  // inputs would be silently discarded — visible to the user as the local
  // player being snapped backward every snapshot (the "bouncing" bug).
  consumeNextInput(): PlayerInput | null {
    let next: PlayerInput | undefined;
    for (const [tick, input] of this.inputBuffer) {
      if (tick > this.lastAppliedInputTick) {
        if (!next || tick < next.tick) next = input;
      }
    }
    if (!next) return null;
    this.lastAppliedInputTick = next.tick;
    this.inputBuffer.delete(next.tick);
    return next;
  }

  send(msg: ServerMessage): void {
    if (!this.alive) return;
    try {
      this.socket.send(encode(msg));
    } catch {
      this.alive = false;
    }
  }

  close(): void {
    this.alive = false;
    try {
      this.socket.close();
    } catch {
      /* noop */
    }
  }
}
