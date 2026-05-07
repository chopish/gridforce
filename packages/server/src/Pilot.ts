// A "Pilot" is anything that can supply inputs for a player on a given tick:
// either a human Connection (drains a buffered input message) or a Bot
// (computes one from internal AI state). The Room treats them uniformly so
// physics steps don't care whether a player is human or AI.

import type { PlayerId, PlayerInput } from '@gridforce/shared';

export interface Pilot {
  readonly playerId: PlayerId;
  readonly isBot: boolean;
  ackInputTick: number;

  // Pulls the input that should drive this player's tick T (or null for "no
  // input arrived"). Has the side effect of marking T as processed for the
  // ack bitmask report below.
  consumeInputForTick(tick: number): PlayerInput | null;

  computeAckBitmask(): number;

  // Send a binary frame downstream. Bots ignore.
  send(bytes: Uint8Array): void;

  // Drop any pending state. Called when the player leaves.
  dispose(): void;
}
