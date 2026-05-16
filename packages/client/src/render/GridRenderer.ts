import { Container, Graphics } from 'pixi.js';

import {
  CONDUCTION_THRESHOLD,
  L0_DOME_MAX_HP,
  L1_PANEL_MAX_HP,
  indexOf,
  type GridDef,
  type TileBuffers,
} from '@gridforce/shared';

const GRID_BG = 0x080a13;
const CONDUCTION_MIN_HP = Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD);

export class GridRenderer {
  root = new Container();
  private gfx = new Graphics();
  private grid: GridDef;
  private tiles: TileBuffers | null = null;

  constructor(grid: GridDef) {
    this.grid = grid;
    this.root.addChild(this.gfx);
    this.redrawAll();
  }

  rebuild(grid: GridDef): void {
    this.grid = grid;
    this.tiles = null;
    this.redrawAll();
  }

  setTiles(tiles: TileBuffers): void {
    if (tiles === this.tiles) return; // reference-equality short-circuit
    this.tiles = tiles;
    this.redrawAll();
  }

  private redrawAll(): void {
    const { cols, rows, panelSize: ps } = this.grid;
    const w = cols * ps;
    const h = rows * ps;
    const g = this.gfx;
    g.clear();
    // Background fill — drawn once per redraw beneath all tiles. Passage
    // tiles intentionally show this through, so the void reads as "the
    // dome has been breached down to nothing."
    g.rect(0, 0, w, h).fill({ color: GRID_BG });

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        this.redrawTile(cx, cy);
      }
    }
  }

  private redrawTile(cx: number, cy: number): void {
    const { cols, panelSize: ps } = this.grid;
    const x = cx * ps;
    const y = cy * ps;

    // Before the first setTiles() call (or after a rebuild) we have no
    // layered state yet. Draw everything as LIVE so the grid isn't blank
    // during the brief window between welcome and first snapshot.
    if (!this.tiles) {
      this.drawLiveTile(cx, cy, x, y, ps);
      return;
    }

    const idx = indexOf(cols, cx, cy);
    const l1 = this.tiles.l1Hp[idx]!;
    const l0 = this.tiles.l0Hp[idx]!;

    if (l1 >= CONDUCTION_MIN_HP) {
      this.drawLiveTile(cx, cy, x, y, ps);
    } else if (l1 > 0) {
      this.drawDamagedTile(x, y, ps, l1 / L1_PANEL_MAX_HP);
    } else if (l0 > 0) {
      this.drawExposedDomeTile(x, y, ps, l0 / L0_DOME_MAX_HP);
    } else {
      this.drawPassageTile(x, y, ps);
    }

    // HP bar for the topmost surviving layer. Only drawn when below max so
    // healthy tiles stay uncluttered.
    if (l1 > 0 && l1 < L1_PANEL_MAX_HP) {
      this.drawHpBar(x, y, ps, l1 / L1_PANEL_MAX_HP, 0x4cc26d);
    } else if (l1 === 0 && l0 > 0 && l0 < L0_DOME_MAX_HP) {
      this.drawHpBar(x, y, ps, l0 / L0_DOME_MAX_HP, 0xc26d4c);
    }
  }

  // Thin bar pinned to the bottom of a tile. `ratio` (0..1) is the fill, color
  // selects between L1 (green) and L0 (orange) so the player can read which
  // layer is currently absorbing damage at a glance.
  private drawHpBar(x: number, y: number, ps: number, ratio: number, color: number): void {
    const g = this.gfx;
    const pad = 4;
    const barW = ps - pad * 2;
    const barH = 3;
    const barX = x + pad;
    const barY = y + ps - pad - barH;
    // Background track.
    g.rect(barX, barY, barW, barH).fill({ color: 0x000000, alpha: 0.55 });
    const fillW = Math.max(0, Math.min(barW, barW * ratio));
    if (fillW > 0) {
      g.rect(barX, barY, fillW, barH).fill({ color, alpha: 0.95 });
    }
  }

  // LIVE-conductive panel — bright blue solar tile. Matches the B1 LIVE
  // look the team already approved; the checkerboard tint reads as the
  // grid being intact and powered.
  private drawLiveTile(cx: number, cy: number, x: number, y: number, ps: number): void {
    const g = this.gfx;
    const fill = (cx + cy) % 2 === 0 ? 0x1a2a4a : 0x223052;
    g.roundRect(x + 2, y + 2, ps - 4, ps - 4, 4)
      .fill({ color: fill, alpha: 0.9 })
      .stroke({ width: 1, color: 0x4488ff, alpha: 0.6 });
  }

  // DAMAGED panel — L1 HP > 0 but below conduction threshold. Amber fill
  // with an X-crack overlay. `damageRatio` is l1/L1_MAX (0..1, but always
  // below CONDUCTION_THRESHOLD here, so really 0..conductionThreshold).
  // We use it to fade alpha so a barely-damaged panel reads brighter
  // than one that's about to break.
  private drawDamagedTile(x: number, y: number, ps: number, damageRatio: number): void {
    const g = this.gfx;
    // damageRatio is 0..CONDUCTION_THRESHOLD; remap to ~0.45..0.85 so we
    // get a visible spread between "just lost conduction" and "almost dead."
    const fillAlpha = 0.45 + 0.4 * Math.min(1, damageRatio / CONDUCTION_THRESHOLD);
    g.rect(x + 2, y + 2, ps - 4, ps - 4).fill({ color: 0xb86c2a, alpha: fillAlpha });
    g.moveTo(x + 6, y + 6)
      .lineTo(x + ps - 6, y + ps - 6)
      .stroke({ width: 2, color: 0x5a2a10, alpha: 0.9 });
    g.moveTo(x + ps - 6, y + 6)
      .lineTo(x + 6, y + ps - 6)
      .stroke({ width: 2, color: 0x5a2a10, alpha: 0.9 });
  }

  // L1 gone, L0 intact — the dome is exposed but not breached. Dark gray
  // pit; `domeRatio` interpolates from near-black (dome about to fail)
  // toward a lighter gray (dome at full HP) so players can see the dome
  // wearing down before it breaches into a passage.
  private drawExposedDomeTile(x: number, y: number, ps: number, domeRatio: number): void {
    const g = this.gfx;
    const ratio = Math.max(0, Math.min(1, domeRatio));
    // Interpolate from 0x111111 (gone soon) to 0x555555 (healthy dome).
    const shade = Math.round(0x11 + (0x55 - 0x11) * ratio);
    const color = (shade << 16) | (shade << 8) | shade;
    g.rect(x + 2, y + 2, ps - 4, ps - 4)
      .fill({ color, alpha: 1 })
      .stroke({ width: 1, color: 0x6a6a6a, alpha: 0.45 });
  }

  // Passage — L0 also at 0. The tile is breached open. Leave the cell
  // mostly transparent so the background shows through, then ring it in
  // dim red so a glance over the grid reads "these are the holes."
  private drawPassageTile(x: number, y: number, ps: number): void {
    const g = this.gfx;
    g.rect(x + 2, y + 2, ps - 4, ps - 4)
      .fill({ color: 0x110000, alpha: 0.85 })
      .stroke({ width: 1, color: 0x882222, alpha: 0.9 });
  }
}
