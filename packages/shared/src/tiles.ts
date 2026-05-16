import {
  CONDUCTION_THRESHOLD,
  L0_DOME_MAX_HP,
  L1_PANEL_MAX_HP,
} from './constants.js';

// Layer enum. Wire-encoded values are stable; use the constants, not the
// raw numbers, anywhere outside the encoder.
export const LayerKind = {
  L0_DOME: 0,
  L1_PANEL: 1,
  L2_ADDON: 2,
} as const;
export type LayerKindValue = (typeof LayerKind)[keyof typeof LayerKind];

// Five parallel byte buffers, each of length cols*rows. Storing per-layer
// (rather than struct-of-arrays per tile) makes RLE encoding per layer
// trivial — a flat-LIVE arena is one or two runs in each buffer.
//
// l1Charge holds ticks-remaining of electrification (v14): a tile that was
// hit by a shock beam stays "live wired" for ~SHOCK_LINGER_TICKS ticks and
// kills any bug that walks onto it during that window. Decremented each
// server tick in Room.physicsStep.
export interface TileBuffers {
  l0Hp: Uint8Array;
  l1Hp: Uint8Array;
  l2Kind: Uint8Array; // 0 = none; future addon kinds get nonzero
  l2Hp: Uint8Array;
  l1Charge: Uint8Array;
}

export function allocateTiles(cols: number, rows: number): TileBuffers {
  const n = cols * rows;
  const l0Hp = new Uint8Array(n);
  l0Hp.fill(L0_DOME_MAX_HP);
  const l1Hp = new Uint8Array(n);
  l1Hp.fill(L1_PANEL_MAX_HP);
  return {
    l0Hp,
    l1Hp,
    l2Kind: new Uint8Array(n),
    l2Hp: new Uint8Array(n),
    l1Charge: new Uint8Array(n),
  };
}

export function indexOf(cols: number, cx: number, cy: number): number {
  return cy * cols + cx;
}

// Topmost present layer (highest L number) at this tile. Returns null if the
// tile is a passage (L0 destroyed and L1 already gone).
export function topmostLayer(t: TileBuffers, idx: number): LayerKindValue | null {
  if (t.l2Kind[idx]! !== 0 && t.l2Hp[idx]! > 0) return LayerKind.L2_ADDON;
  if (t.l1Hp[idx]! > 0) return LayerKind.L1_PANEL;
  if (t.l0Hp[idx]! > 0) return LayerKind.L0_DOME;
  return null;
}

// Apply damage to the topmost layer. Saturates at 0; excess does not spill
// to lower layers (the next tick will hit the next-topmost layer naturally).
export function damageTopmost(t: TileBuffers, idx: number, amount: number): void {
  if (amount <= 0) return;
  const top = topmostLayer(t, idx);
  if (top === null) return;
  if (top === LayerKind.L2_ADDON) {
    t.l2Hp[idx] = Math.max(0, t.l2Hp[idx]! - amount);
  } else if (top === LayerKind.L1_PANEL) {
    t.l1Hp[idx] = Math.max(0, t.l1Hp[idx]! - amount);
  } else {
    t.l0Hp[idx] = Math.max(0, t.l0Hp[idx]! - amount);
  }
}

// Conductive iff L1 panel HP >= CONDUCTION_THRESHOLD × L1 max.
export function conductive(t: TileBuffers, idx: number): boolean {
  return t.l1Hp[idx]! >= Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD);
}

// True if the tile is fully tunneled (L0 destroyed). Used by Crawler AI to
// transition from ATTACKING → TRANSITING.
export function isPassage(t: TileBuffers, idx: number): boolean {
  return t.l0Hp[idx]! === 0 && t.l1Hp[idx]! === 0;
}
