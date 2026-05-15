import { mulberry32, SERVER_TICK_DT_MS, type PlayerInput, type PlayerId } from '@gridforce/shared';

import { Bot } from './Bot.js';

// Picks a random heading every ~1 second, walks that way. Useful for manual
// playtesting smooth remote-player rendering: a moving target with regular
// direction changes that exercises the interpolator.
export class WanderBot extends Bot {
  private rng: () => number;
  private mx = 0;
  private my = 0;
  private nextChangeTick = 0;

  constructor(playerId: PlayerId, seed = playerId * 0x9e3779b1, name = `bot-${playerId}`) {
    super(playerId, name);
    this.rng = mulberry32(seed);
  }

  protected override inputForTick(tick: number): PlayerInput {
    if (tick >= this.nextChangeTick) {
      const angle = this.rng() * Math.PI * 2;
      this.mx = Math.cos(angle);
      this.my = Math.sin(angle);
      // 0.6s..1.4s before next direction change
      const ticksUntil = 18 + Math.floor(this.rng() * 24);
      this.nextChangeTick = tick + ticksUntil;
    }
    return {
      tick,
      clientTimeMs: tick * SERVER_TICK_DT_MS,
      mx: this.mx,
      my: this.my,
      dash: false,
      sprint: false,
      shock: false,
      repair: false,
    };
  }
}
