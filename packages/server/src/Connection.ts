import {
  MAX_INPUT_BUFFER,
  type PlayerId,
  type PlayerInput,
  decodeMessage,
  MessageType,
} from '@gridforce/shared';

import type { Pilot } from './Pilot.js';
import type { Channel, Transport } from './transport/Transport.js';

const INPUT_BUFFER_HARD_CAP = MAX_INPUT_BUFFER;
const APPLIED_HISTORY = 64;

export type ConnectionMessageHandler = (
  conn: Connection,
  decoded: ReturnType<typeof decodeMessage>,
) => void;

export class Connection implements Pilot {
  readonly isBot = false;
  ackInputTick = -1;
  ready = false;

  private inputs = new Map<number, PlayerInput>();
  private appliedTicks = new Set<number>();
  private closed = false;

  constructor(
    public readonly playerId: PlayerId,
    public readonly name: string,
    public readonly sessionKey: string,
    private readonly transport: Transport,
    private readonly onMessage: ConnectionMessageHandler,
  ) {
    transport.onMessage(this.handleBytes);
    transport.onClose(() => {
      this.closed = true;
    });
  }

  private handleBytes = (bytes: Uint8Array): void => {
    if (this.closed) return;
    let decoded: ReturnType<typeof decodeMessage>;
    try {
      decoded = decodeMessage(bytes);
    } catch (err) {
      // Bad frames close the connection — never try to recover from a corrupt stream.
      console.warn(`[conn ${this.playerId}] decode error:`, err);
      this.transport.close(1003, 'bad frame');
      return;
    }

    if (decoded.type === MessageType.Input) {
      // Each Input message carries the client's last N inputs (redundancy
      // window). bufferInput is idempotent w.r.t. tick — duplicates that
      // were already applied are dropped via the ackInputTick check.
      for (const inp of decoded.payload) this.bufferInput(inp);
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

  send(bytes: Uint8Array, channel: Channel = 'reliable'): void {
    if (this.closed) return;
    this.transport.send(bytes, channel);
  }

  close(code = 1000, reason = ''): void {
    this.closed = true;
    this.transport.close(code, reason);
  }

  dispose(): void {
    this.close();
    this.inputs.clear();
    this.appliedTicks.clear();
  }
}
