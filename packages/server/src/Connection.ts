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

    // Bound the buffer; never let it grow unbounded if a client misbehaves
    if (this.inputBuffer.size > 256) {
      const oldestTick = Math.min(...this.inputBuffer.keys());
      this.inputBuffer.delete(oldestTick);
    }
  }

  // Pick the input to apply at the given server tick. Strategy:
  //  - Prefer an exact match for `serverTick`.
  //  - Otherwise use the most recent input with tick <= serverTick.
  //  - Otherwise (no input yet) return a zero input.
  // Once consumed, drop everything <= consumed tick.
  consumeInputForTick(serverTick: number): PlayerInput {
    let best: PlayerInput | undefined;
    for (const [tick, input] of this.inputBuffer) {
      if (tick <= serverTick) {
        if (!best || tick > best.tick) best = input;
      }
    }
    if (best) {
      this.lastAppliedInputTick = best.tick;
      // Drop everything we've passed
      for (const tick of [...this.inputBuffer.keys()]) {
        if (tick <= best.tick) this.inputBuffer.delete(tick);
      }
      return best;
    }
    return { tick: serverTick, mx: 0, my: 0, dash: false };
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
