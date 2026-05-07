import type { PlayerInput, WorldState } from '@gridforce/shared';
import type { Bot } from './Bot.js';

// IdleBot does nothing. Its purpose in Phase 0 is to validate the bot
// abstraction (same interface as a remote socket — emits PlayerInput per tick).
// Smarter bots are just new Bot implementations layered on top.
export class IdleBot implements Bot {
  constructor(public readonly id: string, public readonly name: string) {}

  getInput(_state: WorldState, tick: number): PlayerInput {
    return { tick, mx: 0, my: 0, dash: false };
  }
}
