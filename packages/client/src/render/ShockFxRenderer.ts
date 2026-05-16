import { Container, Graphics } from 'pixi.js';

import { PANEL_SIZE } from '@gridforce/shared';

interface ShockFlash {
  x: number;
  y: number;
  rad: number;        // true cursor angle, screen-y-down
  rangeTiles: number;
  charged: boolean;   // long-hold release vs. tap
  ageMs: number;
  ttlMs: number;
}

const TAP_TTL_MS = 110;
const CHARGED_TTL_MS = 180;

export class ShockFxRenderer {
  root = new Container();
  private gfx = new Graphics();
  private flashes: ShockFlash[] = [];

  constructor() {
    this.root.addChild(this.gfx);
  }

  // Fire a beam at the true aim angle (no cardinal snap). `rangeTiles` is the
  // beam length in tiles (1..MAX). `charged` flips the visual weight so a
  // longer charge reads as a thicker, hotter line.
  fire(x: number, y: number, rad: number, rangeTiles: number, charged: boolean): void {
    this.flashes.push({
      x, y, rad, rangeTiles, charged,
      ageMs: 0,
      ttlMs: charged ? CHARGED_TTL_MS : TAP_TTL_MS,
    });
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
      const ex = f.x + Math.cos(f.rad) * reach;
      const ey = f.y + Math.sin(f.rad) * reach;
      const color = f.charged ? 0xffe55a : 0x6cd0ff;
      const width = f.charged ? 7 : 4;
      g.moveTo(f.x, f.y)
        .lineTo(ex, ey)
        .stroke({ width, color, alpha });
      // Endpoint pop — small circle at the beam tip.
      const popR = (f.charged ? 16 : 11) * (1 - t * 0.5);
      g.circle(ex, ey, popR).fill({ color, alpha: alpha * 0.45 });
    }
  }
}
