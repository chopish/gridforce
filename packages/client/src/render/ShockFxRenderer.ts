import { Container, Graphics } from 'pixi.js';

import { PANEL_SIZE } from '@gridforce/shared';

// Snap a radian angle to its nearest cardinal direction. 0=N (up), 1=E,
// 2=S (down), 3=W. Screen-y-down convention: east = 0 rad, south = +π/2,
// west = π, north = -π/2. Mirrors server-side snapToCardinal in Room.ts.
export function snapToCardinal(rad: number): 0 | 1 | 2 | 3 {
  let f = rad % (Math.PI * 2);
  if (f < 0) f += Math.PI * 2;
  const s = Math.PI / 4;
  if (f < s || f >= 7 * s) return 1;
  if (f < 3 * s) return 2;
  if (f < 5 * s) return 3;
  return 0;
}

interface ShockFlash {
  x: number;
  y: number;
  cardinal: 0 | 1 | 2 | 3;
  rangeTiles: number;
  charged: boolean;
  ageMs: number;
  ttlMs: number;
}

const TAP_TTL_MS = 110;
const CHARGED_TTL_MS = 160;

export class ShockFxRenderer {
  root = new Container();
  private gfx = new Graphics();
  private flashes: ShockFlash[] = [];

  constructor() {
    this.root.addChild(this.gfx);
  }

  fireTap(x: number, y: number, cardinal: 0 | 1 | 2 | 3): void {
    this.flashes.push({ x, y, cardinal, rangeTiles: 1, charged: false, ageMs: 0, ttlMs: TAP_TTL_MS });
  }

  fireCharged(x: number, y: number, cardinal: 0 | 1 | 2 | 3): void {
    this.flashes.push({ x, y, cardinal, rangeTiles: 2, charged: true, ageMs: 0, ttlMs: CHARGED_TTL_MS });
  }

  update(dtMs: number): void {
    if (this.flashes.length === 0) {
      this.gfx.clear();
      return;
    }
    const next: ShockFlash[] = [];
    for (const f of this.flashes) {
      f.ageMs += dtMs;
      if (f.ageMs < f.ttlMs) next.push(f);
    }
    this.flashes = next;
    this.redraw();
  }

  private redraw(): void {
    const g = this.gfx;
    g.clear();
    for (const f of this.flashes) {
      const t = Math.min(1, f.ageMs / f.ttlMs);
      const alpha = (1 - t) * 0.95;
      const reach = f.rangeTiles * PANEL_SIZE;
      // Cardinal direction unit vector (screen-y-down: south is +y).
      let dx = 0;
      let dy = 0;
      if (f.cardinal === 0) dy = -1;
      else if (f.cardinal === 1) dx = 1;
      else if (f.cardinal === 2) dy = 1;
      else dx = -1;
      const ex = f.x + dx * reach;
      const ey = f.y + dy * reach;
      const color = f.charged ? 0xffe55a : 0x6cd0ff;
      const width = f.charged ? 6 : 4;
      g.moveTo(f.x, f.y)
        .lineTo(ex, ey)
        .stroke({ width, color, alpha });
      // Endpoint pop — small circle at the impact tile center.
      const popR = (f.charged ? 14 : 10) * (1 - t * 0.5);
      g.circle(ex, ey, popR).fill({ color, alpha: alpha * 0.45 });
    }
  }
}
