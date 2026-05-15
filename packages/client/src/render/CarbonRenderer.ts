import { Container, Graphics } from 'pixi.js';

import { CARBON_TTL_S } from '@gridforce/shared';

// Bright yellow dot for carbon pickup collectibles.
// Alpha fades linearly from 1.0 (full TTL) to 0.0 (expired) so players
// can see at a glance how much time is left to collect.
// Single-pass redraw each frame, same pattern as CrawlerRenderer.

export class CarbonRenderer {
  readonly root = new Container();
  private gfx = new Graphics();

  constructor() {
    this.root.addChild(this.gfx);
  }

  beginFrame(): void {
    this.gfx.clear();
  }

  draw(id: number, x: number, y: number, ttlS: number): void {
    void id;
    const alpha = Math.max(0, Math.min(1, ttlS / CARBON_TTL_S));
    this.gfx
      .circle(x, y, 5)
      .fill({ color: 0xffd633, alpha });
  }

  endFrame(): void {
    /* single-pass renderer — no-op */
  }
}
