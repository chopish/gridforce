import { Application, Container } from 'pixi.js';

import type { GridDef } from '@gridforce/shared';

import { JumpTargetOverlay } from '../ui/JumpTargetOverlay.js';
import { CameraController } from './CameraController.js';
import { CarbonRenderer } from './CarbonRenderer.js';
import { CrawlerRenderer } from './CrawlerRenderer.js';
import { GridRenderer } from './GridRenderer.js';
import { NpcRenderer } from './NpcRenderer.js';
import { PlayerRenderer } from './PlayerRenderer.js';

// Owns the PixiJS Application and the scene root. Five child renderers do
// the actual drawing: GridRenderer for the static playfield, CarbonRenderer
// for pickups, CrawlerRenderer for melee enemies, NpcRenderer for stress-test
// hostile entities (drawn under players so a dense swarm doesn't hide the
// local player), PlayerRenderer on top.
//
// The world container is transformed each frame via the CameraController so
// all child renderers move and scale together. Call tick(dtMs, localX, localY)
// once per frame (main.ts) to drive the camera follow + zoom and apply the
// transform.
export class Renderer {
  app!: Application;
  playfield: Container | null = null;
  gridRenderer!: GridRenderer;
  crawlerRenderer!: CrawlerRenderer;
  carbonRenderer!: CarbonRenderer;
  npcRenderer!: NpcRenderer;
  playerRenderer!: PlayerRenderer;
  jumpTargetOverlay!: JumpTargetOverlay;

  camera: CameraController | null = null;
  private resizeListener: (() => void) | null = null;
  private wheelListener: ((e: WheelEvent) => void) | null = null;

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
    this.carbonRenderer = new CarbonRenderer();
    this.crawlerRenderer = new CrawlerRenderer();
    this.npcRenderer = new NpcRenderer();
    this.playerRenderer = new PlayerRenderer();
    const worldW = grid.cols * grid.panelSize;
    const worldH = grid.rows * grid.panelSize;

    this.jumpTargetOverlay = new JumpTargetOverlay(grid.panelSize, worldW, worldH);
    // Z-order (back to front): grid → carbon → crawler → npc → player → jump overlay.
    // Overlay sits on top so the dim fade covers everything below it while
    // jumpHeld is true; main.ts toggles its visibility per frame.
    this.playfield.addChild(this.gridRenderer.root);
    this.playfield.addChild(this.carbonRenderer.root);
    this.playfield.addChild(this.crawlerRenderer.root);
    this.playfield.addChild(this.npcRenderer.root);
    this.playfield.addChild(this.playerRenderer.root);
    this.playfield.addChild(this.jumpTargetOverlay.container);

    this.camera = new CameraController({
      viewportW: this.app.screen.width,
      viewportH: this.app.screen.height,
    });
    // Initial center is the middle of the grid; smoothing will catch the
    // local player's position once main.ts starts feeding setTarget() each tick.
    this.camera.center.x = worldW / 2;
    this.camera.center.y = worldH / 2;
    this.camera.setTarget({ x: worldW / 2, y: worldH / 2 });

    // Apply initial transform so the world is centered before the first tick.
    this._applyTransform();

    this.resizeListener = () => {
      const w = this.app.screen.width;
      const h = this.app.screen.height;
      this.camera?.setViewportSize(w, h);
      this._applyTransform();
    };
    window.addEventListener('resize', this.resizeListener);

    // Mouse wheel → zoom. One scroll notch ≈ ±100px of deltaY; we collapse
    // any non-zero delta into a single notch. Browsers that report
    // line-mode (deltaMode=1) or page-mode (deltaMode=2) still flow through
    // the same sign. preventDefault so the page doesn't scroll under the
    // canvas while the game has focus.
    this.wheelListener = (e: WheelEvent) => {
      e.preventDefault();
      if (!this.camera) return;
      const notches = -Math.sign(e.deltaY); // up = zoom in
      if (notches !== 0) this.camera.zoom(notches);
    };
    this.app.canvas.addEventListener('wheel', this.wheelListener, { passive: false });
  }

  /** Replace the current grid (mid-run stage swap). */
  setGrid(grid: GridDef): void {
    if (!this.camera || !this.playfield) return;
    this.gridRenderer.rebuild(grid);
    const worldW = grid.cols * grid.panelSize;
    const worldH = grid.rows * grid.panelSize;
    // Resize the jump-target overlay's dim rect so it still covers the new
    // world. Highlight is redrawn per frame so panelSize lands automatically.
    this.jumpTargetOverlay?.setWorldSize(grid.panelSize, worldW, worldH);
    // Recenter to the new grid's midpoint; main.ts's setTarget on the next
    // frame will smoothly pull the camera onto the local player.
    this.camera.center.x = worldW / 2;
    this.camera.center.y = worldH / 2;
    this.camera.setTarget({ x: worldW / 2, y: worldH / 2 });
    this._applyTransform();
  }

  /**
   * Drive the camera and apply the world transform.
   * Called once per frame by main.ts.
   * @param dtMs  Frame delta in milliseconds.
   * @param localX  World-space X of the local player (camera follow target).
   * @param localY  World-space Y of the local player.
   */
  tick(dtMs: number, localX: number, localY: number): void {
    if (!this.camera || !this.playfield) return;
    this.camera.setTarget({ x: localX, y: localY });
    this.camera.update(dtMs / 1000);
    this._applyTransform();
  }

  private _applyTransform(): void {
    if (!this.camera || !this.playfield) return;
    this.playfield.scale.set(this.camera.zoomLevel);
    const sc = this.camera.worldToScreen({ x: 0, y: 0 });
    this.playfield.position.set(sc.x, sc.y);
  }

  destroy(): void {
    if (this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
      this.resizeListener = null;
    }
    if (this.wheelListener && this.app?.canvas) {
      this.app.canvas.removeEventListener('wheel', this.wheelListener);
      this.wheelListener = null;
    }
    this.app?.destroy(true, { children: true, texture: true });
  }
}
