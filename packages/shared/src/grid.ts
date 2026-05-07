import type { GridDef } from './types.js';
import { GRID_COLS, GRID_ROWS, PANEL_SIZE } from './constants.js';

export function createDefaultGrid(): GridDef {
  return { cols: GRID_COLS, rows: GRID_ROWS, panelSize: PANEL_SIZE };
}

export function worldWidth(g: GridDef): number {
  return g.cols * g.panelSize;
}
export function worldHeight(g: GridDef): number {
  return g.rows * g.panelSize;
}
