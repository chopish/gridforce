import { Container, Graphics } from 'pixi.js';

import type { GridDef } from '@gridforce/shared';

const GRID_BG = 0x080a13;

// Panel state constants (must match server PanelState enum)
const STATE_LIVE = 0;
const STATE_DAMAGED = 1;
const STATE_BROKEN = 2;

export class GridRenderer {
  root = new Container();
  private gfx = new Graphics();
  private grid: GridDef;
  private lastPanelStates: Uint8Array | null = null;

  constructor(grid: GridDef) {
    this.grid = grid;
    this.root.addChild(this.gfx);
    this.draw(grid);
  }

  rebuild(grid: GridDef): void {
    this.grid = grid;
    this.lastPanelStates = null;
    this.draw(grid);
  }

  setPanelStates(buf: Uint8Array): void {
    if (buf === this.lastPanelStates) return; // reference-equality short-circuit
    this.lastPanelStates = buf;
    this.draw(this.grid, buf);
  }

  private draw(grid: GridDef, panelStates?: Uint8Array): void {
    const { cols, rows, panelSize: ps } = grid;
    const w = cols * ps;
    const h = rows * ps;
    const g = this.gfx;
    g.clear();
    // Background fill
    g.rect(0, 0, w, h).fill({ color: GRID_BG });

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = cx * ps;
        const y = cy * ps;
        const state = panelStates ? panelStates[cy * cols + cx] : STATE_LIVE;

        if (state === STATE_DAMAGED) {
          // DAMAGED: dark brownish fill + X-crack pattern
          g.rect(x + 2, y + 2, ps - 4, ps - 4).fill({ color: 0x553322, alpha: 0.8 });
          g.moveTo(x + 8, y + 8)
            .lineTo(x + ps - 8, y + ps - 8)
            .stroke({ width: 2, color: 0x884422, alpha: 1 });
          g.moveTo(x + ps - 8, y + 8)
            .lineTo(x + 8, y + ps - 8)
            .stroke({ width: 2, color: 0x884422, alpha: 1 });
        } else if (state === STATE_BROKEN) {
          // BROKEN: black pit with faint outline
          g.rect(x + 2, y + 2, ps - 4, ps - 4)
            .fill({ color: 0x000000, alpha: 1 })
            .stroke({ width: 1, color: 0x222244, alpha: 0.5 });
        } else {
          // LIVE (default): blue solar panel with checkerboard tint
          const fill = (cx + cy) % 2 === 0 ? 0x1a2a4a : 0x223052;
          g.roundRect(x + 2, y + 2, ps - 4, ps - 4, 4)
            .fill({ color: fill, alpha: 0.9 })
            .stroke({ width: 1, color: 0x4488ff, alpha: 0.6 });
        }
      }
    }
  }
}
