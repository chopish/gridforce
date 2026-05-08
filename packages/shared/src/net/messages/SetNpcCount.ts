import { SCHEMA_VERSION } from '../../constants.js';
import type { SetNpcCountPayload } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: SetNpcCountPayload): Uint8Array {
  const w = new BinaryWriter(8);
  writeHeader(w, MessageType.SetNpcCount, SCHEMA_VERSION);
  w.u16(p.count & 0xffff);
  return w.finish();
}

export function decode(r: BinaryReader): SetNpcCountPayload {
  const count = r.u16();
  return { count };
}
