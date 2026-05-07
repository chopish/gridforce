import { Application, Container } from 'pixi.js';
import { gridPixelHeight, gridPixelWidth, type Grid } from '@gridforce/shared';

export class Renderer {
  app: Application;
  worldRoot: Container;

  constructor() {
    this.app = new Application();
    this.worldRoot = new Container();
  }

  async init(host: HTMLElement, grid: Grid): Promise<void> {
    await this.app.init({
      background: 0x05060a,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.worldRoot);
    this.center(grid);
    window.addEventListener('resize', () => this.center(grid));
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }

  private center(grid: Grid): void {
    const w = gridPixelWidth(grid);
    const h = gridPixelHeight(grid);
    const screenW = this.app.renderer.width / (window.devicePixelRatio || 1);
    const screenH = this.app.renderer.height / (window.devicePixelRatio || 1);
    const scale = Math.min(screenW / (w + 60), screenH / (h + 80), 1);
    this.worldRoot.scale.set(scale);
    this.worldRoot.x = (screenW - w * scale) / 2;
    this.worldRoot.y = (screenH - h * scale) / 2;
  }
}
