import { Container, Graphics } from 'pixi.js';

// Red triangle pointing in the direction the crawler faces.
// Redraws every frame into a single Graphics object (same single-pass
// pattern as GridRenderer) — no per-entity sprite lifecycle needed because
// the count is expected to be small and positions change every tick anyway.

export class CrawlerRenderer {
  readonly root = new Container();
  private gfx = new Graphics();

  constructor() {
    this.root.addChild(this.gfx);
  }

  beginFrame(): void {
    this.gfx.clear();
  }

  draw(id: number, x: number, y: number, facing: number): void {
    void id;
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
