// Server-owned wandering NPC. Bouncing-walker AI: pick a random heading
// every ~0.6-1.4s, walk until the next change or until we hit the world
// edge (which inverts the relevant velocity component).
//
// Phase 0 has no game logic riding on these — they exist purely as
// network-load fixtures so the entity registry, snapshot encoding, and
// AOI hooks can be exercised before the real game NPCs arrive.

import { mulberry32, type GridDef, type NpcState } from '@gridforce/shared';

const SPEED_MIN = 60;
const SPEED_MAX = 140;
const CHANGE_TICKS_MIN = 18; // 0.6 s at 30 Hz
const CHANGE_TICKS_RANGE = 24; // up to +0.8 s

export class Npc {
  private vx = 0;
  private vy = 0;
  private nextChangeTick = 0;
  private rng: () => number;

  // Mutable so we can encode directly off the live state without
  // building a fresh object every snapshot.
  state: NpcState;

  constructor(id: number, x: number, y: number, seed = id * 0x9e3779b1) {
    this.rng = mulberry32(seed >>> 0);
    this.state = { id, x, y, facing: 0, flags: 0 };
  }

  step(dt: number, tick: number, grid: GridDef): void {
    if (tick >= this.nextChangeTick) {
      const angle = this.rng() * Math.PI * 2;
      const speed = SPEED_MIN + this.rng() * (SPEED_MAX - SPEED_MIN);
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.state.facing = angle;
      this.nextChangeTick = tick + CHANGE_TICKS_MIN + Math.floor(this.rng() * CHANGE_TICKS_RANGE);
    }

    let { x, y } = this.state;
    x += this.vx * dt;
    y += this.vy * dt;

    const w = grid.cols * grid.panelSize;
    const h = grid.rows * grid.panelSize;
    if (x < 0) {
      x = -x;
      this.vx = -this.vx;
    } else if (x > w) {
      x = 2 * w - x;
      this.vx = -this.vx;
    }
    if (y < 0) {
      y = -y;
      this.vy = -this.vy;
    } else if (y > h) {
      y = 2 * h - y;
      this.vy = -this.vy;
    }

    this.state.x = x;
    this.state.y = y;
    if (this.vx !== 0 || this.vy !== 0) {
      this.state.facing = Math.atan2(this.vy, this.vx);
    }
  }
}
