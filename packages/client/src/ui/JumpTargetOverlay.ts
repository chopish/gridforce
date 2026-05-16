// Jump-target overlay (Task 22). Two visual elements stacked in a world-space
// container so they pan/zoom with the camera:
//   1. A semi-transparent black fade over the whole world (alpha ~0.25) that
//      dims everything while Shift is held. Pure visual signal that the player
//      has entered jump-modal.
//   2. A bright outlined square at (playerCx + jumpCursorDx, playerCy + jumpCursorDy)
//      marking the tile the panel-jump will land on if Shift is released now.
//
// The overlay is hidden by default. main.ts toggles visibility per frame based
// on inputCapture.isJumpHeld() and pushes the highlight tile via
// setTargetTile() whenever it's visible.

import { Container, Graphics } from 'pixi.js';

export class JumpTargetOverlay {
  readonly container: Container;
  private dimGfx: Graphics;
  private highlightGfx: Graphics;
  private panelSize: number;
  private worldW: number;
  private worldH: number;
  private isVisible = false;

  constructor(panelSize: number, worldW: number, worldH: number) {
    this.panelSize = panelSize;
    this.worldW = worldW;
    this.worldH = worldH;
    this.container = new Container();
    this.container.visible = false;
    this.dimGfx = new Graphics();
    this.highlightGfx = new Graphics();
    this.container.addChild(this.dimGfx);
    this.container.addChild(this.highlightGfx);
    this.redrawDim();
  }

  // Stage swap (Renderer.setGrid) can resize the world. Rebuild the dim layer
  // to cover the new world rect; the highlight is redrawn each frame by
  // setTargetTile so it picks up the new panelSize automatically.
  setWorldSize(panelSize: number, worldW: number, worldH: number): void {
    this.panelSize = panelSize;
    this.worldW = worldW;
    this.worldH = worldH;
    this.redrawDim();
  }

  setVisible(visible: boolean): void {
    if (this.isVisible === visible) return;
    this.isVisible = visible;
    this.container.visible = visible;
  }

  // Draws the highlight square at the tile `(playerCx + dx, playerCy + dy)`.
  // Player tile coords are in panels (Math.floor(worldXY / panelSize)); dx/dy
  // are integer cursor offsets from InputCapture, already clamped to
  // ±PANEL_JUMP_TARGET_RANGE.
  setTargetTile(playerCx: number, playerCy: number, dx: number, dy: number): void {
    const tx = playerCx + dx;
    const ty = playerCy + dy;
    const px = tx * this.panelSize;
    const py = ty * this.panelSize;
    this.highlightGfx.clear();
    // Inset by 2px on each side so the stroke sits inside the tile boundary
    // (otherwise the 3px-wide stroke would bleed into adjacent tiles and look
    // like it's targeting two cells at once).
    this.highlightGfx
      .rect(px + 2, py + 2, this.panelSize - 4, this.panelSize - 4)
      .stroke({ color: 0xffe070, width: 3, alpha: 1.0 });
  }

  private redrawDim(): void {
    this.dimGfx.clear();
    this.dimGfx.rect(0, 0, this.worldW, this.worldH).fill({ color: 0x000000, alpha: 0.25 });
  }
}
