import { INPUT_MSG_MAX_COUNT, SCHEMA_VERSION } from '../../constants.js';
import type { PlayerInput } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

const BUTTON_DASH   = 1 << 0;
const BUTTON_SPRINT = 1 << 1;
const BUTTON_SHOCK  = 1 << 2;
const BUTTON_REPAIR = 1 << 3;

// Wire format:
//   u8 count                  (1..INPUT_MSG_MAX_COUNT)
//   for each input:
//     u32 tick
//     f64 clientTimeMs
//     f32 mx, f32 my
//     u8  buttons              (bit 0 = dash, bit 1 = sprint, bit 2 = shock, bit 3 = repair)
//
// The count carries the redundancy window — the client packs the last N
// inputs in each frame so a single lost packet doesn't lose an input.
// Server dedupes via Connection.bufferInput's tick check, so duplicates
// are free.
export function encode(inputs: PlayerInput[]): Uint8Array {
  if (inputs.length === 0 || inputs.length > INPUT_MSG_MAX_COUNT) {
    throw new RangeError(
      `Input count out of range: got ${inputs.length}, expected 1..${INPUT_MSG_MAX_COUNT}`,
    );
  }
  const w = new BinaryWriter(8 + inputs.length * 17);
  writeHeader(w, MessageType.Input, SCHEMA_VERSION);
  w.u8(inputs.length);
  for (const p of inputs) {
    w.u32(p.tick >>> 0);
    w.f64(p.clientTimeMs);
    w.f32(p.mx);
    w.f32(p.my);
    w.u8(
      (p.dash   ? BUTTON_DASH   : 0) |
      (p.sprint ? BUTTON_SPRINT : 0) |
      (p.shock  ? BUTTON_SHOCK  : 0) |
      (p.repair ? BUTTON_REPAIR : 0)
    );
  }
  return w.finish();
}

export function decode(r: BinaryReader): PlayerInput[] {
  const count = r.u8();
  if (count === 0) return [];
  // Hard cap on count is enforced server-side regardless of what arrived;
  // here we trust the framed length but stop short of allocating a huge
  // array when the count is plausibly bogus.
  if (count > INPUT_MSG_MAX_COUNT) {
    throw new RangeError(`Input count exceeds cap: ${count}`);
  }
  const out = new Array<PlayerInput>(count);
  for (let i = 0; i < count; i++) {
    const tick = r.u32();
    const clientTimeMs = r.f64();
    const mx = r.f32();
    const my = r.f32();
    const buttons = r.u8();
    out[i] = {
      tick,
      clientTimeMs,
      mx,
      my,
      dash:   (buttons & BUTTON_DASH)   !== 0,
      sprint: (buttons & BUTTON_SPRINT) !== 0,
      shock:  (buttons & BUTTON_SHOCK)  !== 0,
      repair: (buttons & BUTTON_REPAIR) !== 0,
    };
  }
  return out;
}
