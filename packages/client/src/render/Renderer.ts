import { Application, Container } from 'pixi.js';

import type { GridDef } from '@gridforce/shared';

import { GridRenderer } from './GridRenderer.js';
import { PlayerRenderer } from './PlayerRenderer.js';

// Owns the PixiJS Application and the scene root. Two child renderers do the
// actual drawing: GridRenderer for the static playfield, PlayerRenderer for
// the active entities. Future entity layers (NPCs, electrodes, etc.) get
// their own Renderer alongside.
export class Renderer {
  app!: Application;
  worldRoot = new Container();
  gridRenderer!: GridRenderer;
  playerRenderer!: PlayerRenderer;

  async init(parent: HTMLElement, grid: GridDef): Promise<void> {
    this.app = new Application();
    await this.app.init({
      background: '#0a0a0f',
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      resizeTo: parent,
    });
    parent.appendChild(this.app.canvas);

    this.app.stage.addChild(this.worldRoot);
    this.gridRenderer = new GridRenderer(grid);
    this.playerRenderer = new PlayerRenderer();
    this.worldRoot.addChild(this.gridRenderer.root);
    this.worldRoot.addChild(this.playerRenderer.root);

    // Center the world. Per-player camera ships later; Phase 0 has no camera
    // movement, just centers the world on the canvas.
    this.recenterOnResize(grid);
    window.addEventListener('resize', () => this.recenterOnResize(grid));
  }

  private recenterOnResize(grid: GridDef): void {
    const w = this.app.renderer.width / (window.devicePixelRatio || 1);
    const h = this.app.renderer.height / (window.devicePixelRatio || 1);
    const worldW = grid.cols * grid.panelSize;
    const worldH = grid.rows * grid.panelSize;
    this.worldRoot.x = Math.max(0, (w - worldW) / 2);
    this.worldRoot.y = Math.max(0, (h - worldH) / 2);
  }

  destroy(): void {
    this.app?.destroy(true, { children: true, texture: true });
  }
}
