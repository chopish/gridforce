import type { PlayerId, PlayerInput } from '@gridforce/shared';

import type { Pilot } from '../Pilot.js';

// Base class for AI players. Subclasses override `inputForTick` to compute
// the input that drives the player on a given server tick.
//
// Bots are pure consumers of game state for now (Phase 0): they don't react
// to other players, just produce inputs by themselves. When NPCs ship, bots
// will get visibility into nearby entities for combat coordination.
export abstract class Bot implements Pilot {
  readonly isBot = true;
  ackInputTick = -1;
  // Bots never block a round-start — they're "ready" by definition.
  ready = true;

  constructor(
    public readonly playerId: PlayerId,
    public readonly name: string = '',
  ) {}

  protected abstract inputForTick(tick: number): PlayerInput | null;

  consumeInputForTick(tick: number): PlayerInput | null {
    if (tick > this.ackInputTick) this.ackInputTick = tick;
    return this.inputForTick(tick);
  }

  computeAckBitmask(): number {
    return 0;
  }

  send(_bytes: Uint8Array, _channel?: 'reliable' | 'unreliable'): void {
    // bots don't receive snapshots
  }

  dispose(): void {
    // nothing to clean up
  }
}
