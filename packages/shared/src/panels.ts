import type { BinaryReader, BinaryWriter } from './net/wire.js';

// Panel state — wire-encoded as a u8 enum.
export const PanelState = {
  LIVE: 0,
  DAMAGED: 1,
  BROKEN: 2,
} as const;
export type PanelStateValue = (typeof PanelState)[keyof typeof PanelState];

export function allLive(cols: number, rows: number): Uint8Array {
  const buf = new Uint8Array(cols * rows);
  // Uint8Array initializes to 0, which is PanelState.LIVE — no explicit fill needed.
  return buf;
}

export function indexOf(cols: number, cx: number, cy: number): number {
  return cy * cols + cx;
}

// RLE format:
//   varuint runCount
//   for each run:
//     u8 state
//     varuint runLength
//
// Decoder needs to know the total expected cell count for sanity-checking;
// callers pass it because the snapshot length is implicit upstream.
export function encodeRle(w: BinaryWriter, buf: Uint8Array): void {
  if (buf.length === 0) {
    w.varuint(0);
    return;
  }
  // First pass: count runs.
  let runs = 1;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] !== buf[i - 1]) runs++;
  }
  w.varuint(runs);
  let runStart = 0;
  for (let i = 1; i <= buf.length; i++) {
    if (i === buf.length || buf[i] !== buf[runStart]) {
      w.u8(buf[runStart]!);
      w.varuint(i - runStart);
      runStart = i;
    }
  }
}

export function decodeRle(r: BinaryReader, expectedLen: number): Uint8Array {
  const runCount = r.varuint();
  const out = new Uint8Array(expectedLen);
  let cursor = 0;
  for (let n = 0; n < runCount; n++) {
    const state = r.u8();
    const len = r.varuint();
    if (cursor + len > expectedLen) {
      throw new RangeError(`RLE overflow: cursor=${cursor} len=${len} expectedLen=${expectedLen}`);
    }
    out.fill(state, cursor, cursor + len);
    cursor += len;
  }
  if (cursor !== expectedLen) {
    throw new RangeError(`RLE underflow: cursor=${cursor} expectedLen=${expectedLen}`);
  }
  return out;
}
