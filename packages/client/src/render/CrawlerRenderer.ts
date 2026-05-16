import { Container, Graphics } from 'pixi.js';

import { CrawlerAIState, type CrawlerAIStateValue } from '@gridforce/shared';

// Red triangle pointing in the direction the crawler faces, with a yellow
// pulse outline when ATTACKING so the player can see which bugs are
// actively biting tiles vs. which are still walking up.
//
// Redraws every frame into a single Graphics object (same single-pass
// pattern as GridRenderer) — no per-entity sprite lifecycle needed because
// the count is expected to be small and positions change every tick anyway.

export class CrawlerRenderer {
  readonly root = new Container();
  private gfx = new Graphics();
  private nowMs = 0;

  constructor() {
    this.root.addChild(this.gfx);
  }

  // Caller invokes this once per frame with the current performance.now() so
  // the attack pulse phase is continuous across draws.
  beginFrame(nowMs?: number): void {
    this.gfx.clear();
    if (typeof nowMs === 'number') this.nowMs = nowMs;
  }

  draw(id: number, x: number, y: number, facing: number, ai?: CrawlerAIStateValue): void {
    void id;
    // Attack pulse: when ATTACKING, breathe a yellow ring around the bug at
    // ~3 Hz so it visibly throbs while damaging a tile.
    if (ai === CrawlerAIState.ATTACKING) {
      const phase = (this.nowMs / 1000) * Math.PI * 6; // 3 Hz
      const pulse = 0.5 + 0.5 * Math.sin(phase);
      const r = 13 + pulse * 5;
      this.gfx.circle(x, y, r).stroke({ width: 2, color: 0xffe55a, alpha: 0.45 + 0.4 * pulse });
    }
    // Red triangle: tip points forward, base trails behind.
    const fwd = 10;
    const back = 8;
    const tipX = x + Math.cos(facing) * fwd;
    const tipY = y + Math.sin(facing) * fwd;
    const leftX = x + Math.cos(facing + 2.5) * back;
    const leftY = y + Math.sin(facing + 2.5) * back;
    const rightX = x + Math.cos(facing - 2.5) * back;
    const rightY = y + Math.sin(facing - 2.5) * back;
    this.gfx
      .poly([tipX, tipY, leftX, leftY, rightX, rightY])
      .fill({ color: 0xcc3333, alpha: 1 });
  }

  endFrame(): void {
    /* single-pass renderer — no-op */
  }
}
