import { Container, Graphics } from 'pixi.js';

import type { GridDef } from '@gridforce/shared';

const PANEL_FILL = 0x121826;
const PANEL_STROKE = 0x1f2a44;
const PANEL_HIGHLIGHT = 0x223052;
const GRID_BG = 0x080a13;

// Phase 0 grid: a flat field of solar panels. Just visual; no game-affecting
// state (no HP, no shock, no live/dead distinction). Future revs will track
// per-panel state (cracked / live / dead) and re-draw on change.
export class GridRenderer {
  root = new Container();
  private gfx = new Graphics();

  constructor(grid: GridDef) {
    this.root.addChild(this.gfx);
    this.draw(grid);
  }

  rebuild(grid: GridDef): void {
    this.draw(grid);
  }

  private draw(grid: GridDef): void {
    const { cols, rows, panelSize: ps } = grid;
    const w = cols * ps;
    const h = rows * ps;
    const g = this.gfx;
    g.clear();
    g.rect(0, 0, w, h).fill({ color: GRID_BG });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * ps + 1;
        const y = r * ps + 1;
        const innerW = ps - 2;
        const innerH = ps - 2;
        const fill = (c + r) % 2 === 0 ? PANEL_FILL : PANEL_HIGHLIGHT;
        g.roundRect(x, y, innerW, innerH, 4)
          .fill({ color: fill, alpha: 0.9 })
          .stroke({ width: 1, color: PANEL_STROKE, alpha: 0.6 });
      }
    }
  }
}
