import { Application, Container } from 'pixi.js';

import type { GridDef } from '@gridforce/shared';

import { Camera } from './Camera.js';
import { GridRenderer } from './GridRenderer.js';
import { NpcRenderer } from './NpcRenderer.js';
import { PlayerRenderer } from './PlayerRenderer.js';

// Owns the PixiJS Application and the scene root. Three child renderers do
// the actual drawing: GridRenderer for the static playfield, NpcRenderer
// for hostile entities (drawn under players so a dense NPC swarm doesn't
// hide the local player), PlayerRenderer on top.
//
// The playfield container is translated each frame via the Camera so all
// child renderers move together. Call tick(dtMs, localX, localY) once per
// frame (main.ts, Task 9) to drive the camera and apply the offset.
export class Renderer {
  app!: Application;
  /** @deprecated use playfield — kept for backwards compatibility */
  get worldRoot(): Container {
    return this.playfield ?? new Container();
  }
  playfield: Container | null = null;
  gridRenderer!: GridRenderer;
  npcRenderer!: NpcRenderer;
  playerRenderer!: PlayerRenderer;

  private camera: Camera | null = null;
  private resizeListener: (() => void) | null = null;

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

    this.playfield = new Container();
    this.app.stage.addChild(this.playfield);

    this.gridRenderer = new GridRenderer(grid);
    this.npcRenderer = new NpcRenderer();
    this.playerRenderer = new PlayerRenderer();
    this.playfield.addChild(this.gridRenderer.root);
    this.playfield.addChild(this.npcRenderer.root);
    this.playfield.addChild(this.playerRenderer.root);

    const worldW = grid.cols * grid.panelSize;
    const worldH = grid.rows * grid.panelSize;

    this.camera = new Camera({
      viewportW: this.app.screen.width,
      viewportH: this.app.screen.height,
      worldW,
      worldH,
    });
    this.camera.snapTo(worldW / 2, worldH / 2);

    // Apply initial offset so the world is centered before the first tick.
    this._applyOffset();

    this.resizeListener = () => {
      const w = this.app.screen.width;
      const h = this.app.screen.height;
      this.camera?.resize(w, h);
      this._applyOffset();
    };
    window.addEventListener('resize', this.resizeListener);
  }

  /** Replace the current grid (mid-run stage swap). */
  setGrid(grid: GridDef): void {
    if (!this.camera || !this.playfield) return;
    this.gridRenderer.rebuild(grid);
    this.camera.setWorldBounds(grid.cols * grid.panelSize, grid.rows * grid.panelSize);
  }

  /**
   * Drive the camera and apply the playfield offset.
   * Called once per frame by main.ts (Task 9).
   * @param dtMs  Frame delta in milliseconds.
   * @param localX  World-space X of the local player (camera follow target).
   * @param localY  World-space Y of the local player.
   */
  tick(dtMs: number, localX: number, localY: number): void {
    if (!this.camera || !this.playfield) return;
    this.camera.update(localX, localY, dtMs / 1000);
    this._applyOffset();
  }

  private _applyOffset(): void {
    if (!this.camera || !this.playfield) return;
    const off = this.camera.worldToScreenOffset();
    this.playfield.position.set(off.x, off.y);
  }

  destroy(): void {
    if (this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
      this.resizeListener = null;
    }
    this.app?.destroy(true, { children: true, texture: true });
  }
}
