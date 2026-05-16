// MinimapRenderer (C1 Task 23). Top-right overlay (~180×180px) drawn in
// screen-space — i.e. NOT a child of the world container, so it does not
// pan or zoom with the camera. Reads the same client-mirrored state the
// main renderer uses; no new wire data.
//
// Visual layers (back→front):
//   1. background plate (translucent black + thin outline)
//   2. tiles: each minimap cell is colored by tileColor(l1, l0)
//   3. danger highlight: cells whose aggregate crawler weight (own + 4
//      cardinal neighbors) meets MINIMAP_DANGER_WEIGHT_THRESHOLD pulse yellow
//   4. entity dots: cyan for players, red for crawlers; off-screen crawler
//      dots blink faster than on-screen ones
//
// Click-to-pan: clicking a minimap cell calls back into the camera with a
// world-space point, which Renderer wires to camera.setCenter().

import { Container, FederatedPointerEvent, Graphics } from 'pixi.js';

import {
  CONDUCTION_THRESHOLD,
  CRAWLER_WEIGHT,
  CrawlerAIState,
  L1_PANEL_MAX_HP,
  MINIMAP_DANGER_WEIGHT_THRESHOLD,
  MINIMAP_SIZE_PX,
  PANEL_SIZE,
  indexOf,
  type CrawlerState,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

export type TileKind = 'live' | 'damaged' | 'dome' | 'passage';

/**
 * Resolve a tile color from its layered HP. Pure function — extracted so
 * the color-resolution logic is testable without Pixi.
 *
 *   live    — L1 panel is alive and conductive (≥ CONDUCTION_THRESHOLD)
 *   damaged — L1 panel is alive but below the conduction threshold
 *   dome    — L1 panel is gone, L0 dome still standing
 *   passage — both L0 and L1 are gone (crawlers can walk through)
 */
export function tileColor(l1Hp: number, l0Hp: number): { kind: TileKind; color: number } {
  const conductionMin = Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD);
  if (l1Hp >= conductionMin) return { kind: 'live', color: 0x4a90e2 };
  if (l1Hp > 0) return { kind: 'damaged', color: 0xb86c2a };
  if (l0Hp > 0) return { kind: 'dome', color: 0x444444 };
  return { kind: 'passage', color: 0x661111 };
}

export interface CameraViewRect {
  /** world-space left edge */
  l: number;
  /** world-space top edge */
  t: number;
  /** world-space right edge */
  r: number;
  /** world-space bottom edge */
  b: number;
}

export class MinimapRenderer {
  readonly container: Container;
  private bg = new Graphics();
  private tilesGfx = new Graphics();
  private dangerGfx = new Graphics();
  private entitiesGfx = new Graphics();
  private cols: number;
  private rows: number;
  private timeS = 0;
  private onPanRequest: ((world: { x: number; y: number }) => void) | null = null;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.container = new Container();
    this.container.addChild(this.bg);
    this.container.addChild(this.tilesGfx);
    this.container.addChild(this.dangerGfx);
    this.container.addChild(this.entitiesGfx);
    this.container.eventMode = 'static';
    this.container.on('pointerdown', this.handleClick);
    this.drawBackground();
  }

  /** Replace grid dimensions on a stage swap. */
  setDims(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  setPanRequestCallback(cb: (world: { x: number; y: number }) => void): void {
    this.onPanRequest = cb;
  }

  render(
    tiles: TileBuffers,
    players: PlayerState[],
    crawlers: CrawlerState[],
    cameraView: CameraViewRect,
    dt: number,
  ): void {
    this.timeS += dt;
    const cellW = MINIMAP_SIZE_PX / this.cols;
    const cellH = MINIMAP_SIZE_PX / this.rows;

    // --- Tiles ---
    this.tilesGfx.clear();
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const idx = indexOf(this.cols, cx, cy);
        const { color } = tileColor(tiles.l1Hp[idx]!, tiles.l0Hp[idx]!);
        this.tilesGfx.rect(cx * cellW, cy * cellH, cellW, cellH).fill({ color });
      }
    }

    // --- Danger highlight ---
    // Aggregate ATTACKING-crawler weight per tile, then sum each tile with
    // its 4 cardinal neighbors so a single attacker bleeds onto adjacent
    // cells (telegraphs the threat radius). Tiles with weight ≥ threshold
    // pulse yellow.
    this.dangerGfx.clear();
    const weightAt = new Uint16Array(this.cols * this.rows);
    for (const c of crawlers) {
      if (c.ai !== CrawlerAIState.ATTACKING) continue;
      if (c.targetCx < 0 || c.targetCx >= this.cols) continue;
      if (c.targetCy < 0 || c.targetCy >= this.rows) continue;
      const wIdx = indexOf(this.cols, c.targetCx, c.targetCy);
      weightAt[wIdx] = (weightAt[wIdx] ?? 0) + CRAWLER_WEIGHT;
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.timeS * 5);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const idx = indexOf(this.cols, cx, cy);
        let w = weightAt[idx]!;
        if (cx > 0) w += weightAt[indexOf(this.cols, cx - 1, cy)]!;
        if (cx < this.cols - 1) w += weightAt[indexOf(this.cols, cx + 1, cy)]!;
        if (cy > 0) w += weightAt[indexOf(this.cols, cx, cy - 1)]!;
        if (cy < this.rows - 1) w += weightAt[indexOf(this.cols, cx, cy + 1)]!;
        if (w >= MINIMAP_DANGER_WEIGHT_THRESHOLD) {
          this.dangerGfx
            .rect(cx * cellW, cy * cellH, cellW, cellH)
            .stroke({ color: 0xffff00, width: 1, alpha: 0.4 + 0.6 * pulse });
        }
      }
    }

    // --- Entities ---
    this.entitiesGfx.clear();
    for (const p of players) {
      const sx = (p.x / PANEL_SIZE) * cellW;
      const sy = (p.y / PANEL_SIZE) * cellH;
      this.entitiesGfx.circle(sx, sy, Math.max(2, cellW / 2)).fill({ color: 0x66ddff });
    }
    // Off-screen crawlers blink with a faster modulation so the player can
    // tell at a glance "there's a threat off-camera." On-screen crawlers
    // render with full alpha — no point pinging something already visible.
    const offBlink = 0.4 + 0.6 * Math.abs(Math.sin(this.timeS * 10));
    for (const c of crawlers) {
      const sx = (c.x / PANEL_SIZE) * cellW;
      const sy = (c.y / PANEL_SIZE) * cellH;
      const onScreen =
        c.x >= cameraView.l && c.x <= cameraView.r && c.y >= cameraView.t && c.y <= cameraView.b;
      const alpha = onScreen ? 1.0 : offBlink;
      this.entitiesGfx.circle(sx, sy, Math.max(1.5, cellW / 3)).fill({ color: 0xff5050, alpha });
    }
  }

  destroy(): void {
    this.container.off('pointerdown', this.handleClick);
    this.container.destroy({ children: true });
  }

  private drawBackground(): void {
    this.bg.clear();
    this.bg.rect(0, 0, MINIMAP_SIZE_PX, MINIMAP_SIZE_PX).fill({ color: 0x000000, alpha: 0.55 });
    this.bg
      .rect(0, 0, MINIMAP_SIZE_PX, MINIMAP_SIZE_PX)
      .stroke({ color: 0xffffff, width: 1, alpha: 0.4 });
  }

  private handleClick = (e: FederatedPointerEvent): void => {
    if (!this.onPanRequest) return;
    const local = e.getLocalPosition(this.container);
    if (local.x < 0 || local.x > MINIMAP_SIZE_PX || local.y < 0 || local.y > MINIMAP_SIZE_PX) {
      return;
    }
    const cellW = MINIMAP_SIZE_PX / this.cols;
    const cellH = MINIMAP_SIZE_PX / this.rows;
    const cx = local.x / cellW;
    const cy = local.y / cellH;
    const wx = cx * PANEL_SIZE;
    const wy = cy * PANEL_SIZE;
    this.onPanRequest({ x: wx, y: wy });
  };
}
