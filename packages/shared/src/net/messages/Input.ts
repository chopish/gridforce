import { INPUT_MSG_MAX_COUNT, PANEL_JUMP_TARGET_RANGE, SCHEMA_VERSION } from '../../constants.js';
import type { PlayerInput } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

const BUTTON_SHOCK     = 1 << 0;
const BUTTON_REPAIR    = 1 << 1;
const BUTTON_JUMP_HELD = 1 << 2;

const TWO_PI = Math.PI * 2;
function quantizeFacing(rad: number): number {
  let f = rad % TWO_PI;
  if (f < 0) f += TWO_PI;
  return Math.round((f / TWO_PI) * 256) & 0xff;
}
function unquantizeFacing(q: number): number {
  return (q / 256) * TWO_PI;
}

function clampOffset(v: number): number {
  if (v > PANEL_JUMP_TARGET_RANGE) return PANEL_JUMP_TARGET_RANGE;
  if (v < -PANEL_JUMP_TARGET_RANGE) return -PANEL_JUMP_TARGET_RANGE;
  return v | 0;
}

// Wire format (v13):
//   u8 count
//   for each input:
//     u32 tick
//     f64 clientTimeMs
//     f32 mx, f32 my
//     u8  buttons          (bit0=shock, bit1=repair, bit2=jumpHeld)
//     i8  jumpCursorDx     (-PANEL_JUMP_TARGET_RANGE..+PANEL_JUMP_TARGET_RANGE)
//     i8  jumpCursorDy     (same)
//     u8  facingRadQ       (quantized 0..255 over 2π)
export function encode(inputs: PlayerInput[]): Uint8Array {
  if (inputs.length === 0 || inputs.length > INPUT_MSG_MAX_COUNT) {
    throw new RangeError(
      `Input count out of range: got ${inputs.length}, expected 1..${INPUT_MSG_MAX_COUNT}`,
    );
  }
  const w = new BinaryWriter(8 + inputs.length * 24);
  writeHeader(w, MessageType.Input, SCHEMA_VERSION);
  w.u8(inputs.length);
  for (const p of inputs) {
    w.u32(p.tick >>> 0);
    w.f64(p.clientTimeMs);
    w.f32(p.mx);
    w.f32(p.my);
    w.u8(
      (p.shock     ? BUTTON_SHOCK     : 0) |
      (p.repair    ? BUTTON_REPAIR    : 0) |
      (p.jumpHeld  ? BUTTON_JUMP_HELD : 0)
    );
    w.i8(clampOffset(p.jumpCursorDx));
    w.i8(clampOffset(p.jumpCursorDy));
    w.u8(quantizeFacing(p.facingRad));
  }
  return w.finish();
}

export function decode(r: BinaryReader): PlayerInput[] {
  const count = r.u8();
  if (count === 0) return [];
  if (count > INPUT_MSG_MAX_COUNT) throw new RangeError(`Input count exceeds cap: ${count}`);
  const out = new Array<PlayerInput>(count);
  for (let i = 0; i < count; i++) {
    const tick = r.u32();
    const clientTimeMs = r.f64();
    const mx = r.f32();
    const my = r.f32();
    const buttons = r.u8();
    const jumpCursorDx = r.i8();
    const jumpCursorDy = r.i8();
    const facingRad = unquantizeFacing(r.u8());
    out[i] = {
      tick,
      clientTimeMs,
      mx,
      my,
      shock:        (buttons & BUTTON_SHOCK)     !== 0,
      repair:       (buttons & BUTTON_REPAIR)    !== 0,
      jumpHeld:     (buttons & BUTTON_JUMP_HELD) !== 0,
      jumpCursorDx,
      jumpCursorDy,
      facingRad,
    };
  }
  return out;
}
