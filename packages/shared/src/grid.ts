import { TILE_SIZE } from './constants.js';
import type { Grid, Panel, PanelState } from './types.js';

export function createGrid(width: number, height: number, state: PanelState = 'LIVE'): Grid {
  const panels: Panel[] = new Array(width * height);
  for (let i = 0; i < panels.length; i++) {
    panels[i] = { state, hp: 100 };
  }
  return { width, height, panels };
}

export function panelIndex(grid: Grid, col: number, row: number): number {
  return row * grid.width + col;
}

export function getPanel(grid: Grid, col: number, row: number): Panel | undefined {
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return undefined;
  return grid.panels[panelIndex(grid, col, row)];
}

export function worldToTile(x: number, y: number): { col: number; row: number } {
  return {
    col: Math.floor(x / TILE_SIZE),
    row: Math.floor(y / TILE_SIZE),
  };
}

export function tileToWorld(col: number, row: number): { x: number; y: number } {
  return {
    x: (col + 0.5) * TILE_SIZE,
    y: (row + 0.5) * TILE_SIZE,
  };
}

export function gridPixelWidth(grid: Grid): number {
  return grid.width * TILE_SIZE;
}

export function gridPixelHeight(grid: Grid): number {
  return grid.height * TILE_SIZE;
}

export function cloneGrid(grid: Grid): Grid {
  return {
    width: grid.width,
    height: grid.height,
    panels: grid.panels.map((p) => ({ state: p.state, hp: p.hp })),
  };
}
