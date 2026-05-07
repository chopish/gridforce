import type { WebSocket } from 'ws';

import {
  MAX_INPUT_BUFFER,
  type PlayerId,
  type PlayerInput,
  decodeMessage,
  MessageType,
} from '@gridforce/shared';

import type { Pilot } from './Pilot.js';

const INPUT_BUFFER_HARD_CAP = MAX_INPUT_BUFFER;
const APPLIED_HISTORY = 64;

export type ConnectionMessageHandler = (
  conn: Connection,
  decoded: ReturnType<typeof decodeMessage>,
) => void;

export class Connection implements Pilot {
  readonly isBot = false;
  ackInputTick = -1;

  private inputs = new Map<number, PlayerInput>();
  private appliedTicks = new Set<number>();
  private closed = false;

  constructor(
    public readonly playerId: PlayerId,
    private readonly ws: WebSocket,
    private readonly onMessage: ConnectionMessageHandler,
  ) {
    ws.on('message', this.handleRaw);
    ws.on('close', () => {
      this.closed = true;
    });
    ws.on('error', () => {
      this.closed = true;
    });
  }

  private handleRaw = (data: unknown, isBinary: boolean): void => {
    if (this.closed) return;
    if (!isBinary) return; // text frames are ignored
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Buffer) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (Array.isArray(data)) {
      // ws's "fragment" array form
      const total = data.reduce((n, b: Buffer) => n + b.byteLength, 0);
      bytes = new Uint8Array(total);
      let off = 0;
      for (const b of data as Buffer[]) {
        bytes.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
        off += b.byteLength;
      }
    } else {
      return;
    }

    let decoded: ReturnType<typeof decodeMessage>;
    try {
      decoded = decodeMessage(bytes);
    } catch (err) {
      // Bad frames close the connection — never try to recover from a corrupt stream.
      console.warn(`[conn ${this.playerId}] decode error:`, err);
      this.ws.close(1003, 'bad frame');
      return;
    }

    if (decoded.type === MessageType.Input) {
      this.bufferInput(decoded.payload);
      return;
    }

    this.onMessage(this, decoded);
  };

  private bufferInput(input: PlayerInput): void {
    if (input.tick <= this.ackInputTick) return;
    if (this.inputs.size >= INPUT_BUFFER_HARD_CAP) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const t of this.inputs.keys()) if (t < oldest) oldest = t;
      if (Number.isFinite(oldest)) this.inputs.delete(oldest);
    }
    this.inputs.set(input.tick, input);
  }

  consumeInputForTick(targetTick: number): PlayerInput | null {
    const input = this.inputs.get(targetTick) ?? null;
    if (input) {
      this.inputs.delete(targetTick);
      this.appliedTicks.add(targetTick);
    }
    if (targetTick > this.ackInputTick) this.ackInputTick = targetTick;

    // Drop any older inputs we never got around to (shouldn't happen often,
    // but guards against pathological clients).
    for (const t of this.inputs.keys()) {
      if (t < targetTick) this.inputs.delete(t);
    }

    if (this.appliedTicks.size > APPLIED_HISTORY) {
      const cutoff = this.ackInputTick - APPLIED_HISTORY;
      for (const t of this.appliedTicks) {
        if (t < cutoff) this.appliedTicks.delete(t);
      }
    }

    return input;
  }

  computeAckBitmask(): number {
    if (this.ackInputTick < 0) return 0;
    let mask = 0;
    for (let i = 0; i < 32; i++) {
      const t = this.ackInputTick - 1 - i;
      if (t < 0) break;
      if (this.appliedTicks.has(t)) mask |= 1 << i;
    }
    return mask >>> 0;
  }

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(bytes, { binary: true });
    } catch {
      this.closed = true;
    }
  }

  close(code = 1000, reason = ''): void {
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  dispose(): void {
    this.close();
    this.inputs.clear();
    this.appliedTicks.clear();
  }
}
