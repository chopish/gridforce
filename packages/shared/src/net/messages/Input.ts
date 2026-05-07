import { SCHEMA_VERSION } from '../../constants.js';
import type { PlayerInput } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

const BUTTON_DASH = 1 << 0;

export function encode(p: PlayerInput): Uint8Array {
  const w = new BinaryWriter(32);
  writeHeader(w, MessageType.Input, SCHEMA_VERSION);
  w.u32(p.tick >>> 0);
  w.f64(p.clientTimeMs);
  w.f32(p.mx);
  w.f32(p.my);
  w.u8(p.dash ? BUTTON_DASH : 0);
  return w.finish();
}

export function decode(r: BinaryReader): PlayerInput {
  const tick = r.u32();
  const clientTimeMs = r.f64();
  const mx = r.f32();
  const my = r.f32();
  const buttons = r.u8();
  return { tick, clientTimeMs, mx, my, dash: (buttons & BUTTON_DASH) !== 0 };
}
