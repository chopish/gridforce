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
  private heldInput: PlayerInput = { tick: -1, mx: 0, my: 0, dash: false };

  // Last input tick the server has processed for this player. "Processed" may
  // mean applied or superseded as stale; either way the client can stop
  // replaying it after this value is acked in a snapshot.
  lastAppliedInputTick = -1;

  alive = true;

  constructor(playerId: string, name: string, socket: WebSocket) {
    this.playerId = playerId;
    this.name = name;
    this.socket = socket;
  }

  bufferInput(input: PlayerInput): void {
    if (input.tick <= this.lastAppliedInputTick) return;
    this.inputBuffer.set(input.tick, input);

    // Cap is generous — at 60 Hz this allows ~17 s of buffered inputs before
    // we start dropping oldest. If that ever happens, mark the dropped tick as
    // processed so the client does not replay an input the server will never
    // consume.
    if (this.inputBuffer.size > 1024) {
      const oldestTick = Math.min(...this.inputBuffer.keys());
      this.inputBuffer.delete(oldestTick);
      if (oldestTick > this.lastAppliedInputTick) this.lastAppliedInputTick = oldestTick;
    }
  }

  // Number of inputs currently buffered (waiting to be consumed).
  bufferedInputCount(): number {
    this.dropProcessedInputs();
    return this.inputBuffer.size;
  }

  // Returns the newest buffered input intended for or before targetTick. Inputs
  // older than that are processed as stale/superseded because their world tick
  // has already passed. If no input has arrived for this tick, keep moving with
  // the last non-dash movement input instead of injecting a one-tick stop.
  consumeInputForTick(targetTick: number): PlayerInput {
    this.dropProcessedInputs();
    let best: PlayerInput | undefined;
    for (const [tick, input] of this.inputBuffer) {
      if (tick <= targetTick) {
        if (!best || tick > best.tick) best = input;
      }
    }
    if (!best) {
      return { ...this.heldInput, tick: targetTick, dash: false };
    }

    this.lastAppliedInputTick = best.tick;
    this.dropProcessedInputs();
    this.heldInput = { ...best, dash: false };
    return best;
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

  private dropProcessedInputs(): void {
    for (const tick of [...this.inputBuffer.keys()]) {
      if (tick <= this.lastAppliedInputTick) this.inputBuffer.delete(tick);
    }
  }
}
