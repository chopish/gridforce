import { Container, Graphics } from 'pixi.js';
import { TILE_SIZE, type Grid } from '@gridforce/shared';

const PANEL_LIVE_FILL = 0x162038;
const PANEL_LIVE_STROKE = 0x2a3f6e;
const PANEL_LIVE_GLOW = 0x6ee7ff;
const PANEL_DAMAGED_FILL = 0x1d1817;
const PANEL_DAMAGED_STROKE = 0x4a3a2a;
const PANEL_BROKEN_FILL = 0x070707;
const PANEL_BROKEN_STROKE = 0x1a1a1a;

export class GridRenderer {
  readonly view: Container;
  private g: Graphics;

  constructor() {
    this.view = new Container();
    this.g = new Graphics();
    this.view.addChild(this.g);
  }

  render(grid: Grid): void {
    const g = this.g;
    g.clear();

    // Draw grid background (slightly outside grid for ambience)
    const w = grid.width * TILE_SIZE;
    const h = grid.height * TILE_SIZE;
    g.rect(-12, -12, w + 24, h + 24).fill({ color: 0x05060a });

    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const idx = row * grid.width + col;
        const panel = grid.panels[idx]!;
        const x = col * TILE_SIZE;
        const y = row * TILE_SIZE;

        let fill = PANEL_BROKEN_FILL;
        let stroke = PANEL_BROKEN_STROKE;
        if (panel.state === 'LIVE') {
          fill = PANEL_LIVE_FILL;
          stroke = PANEL_LIVE_STROKE;
        } else if (panel.state === 'DAMAGED') {
          fill = PANEL_DAMAGED_FILL;
          stroke = PANEL_DAMAGED_STROKE;
        }

        g.rect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 4)
          .fill({ color: fill })
          .stroke({ color: stroke, width: 1, alignment: 1 });

        if (panel.state === 'LIVE') {
          // Subtle inner highlight to imply solar-cell sheen
          g.rect(x + 6, y + 6, TILE_SIZE - 12, 2).fill({ color: PANEL_LIVE_GLOW, alpha: 0.18 });
        }
      }
    }
  }
}
