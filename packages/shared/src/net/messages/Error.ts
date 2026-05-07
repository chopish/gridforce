import { SCHEMA_VERSION } from '../../constants.js';
import type { ErrorPayload } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: ErrorPayload): Uint8Array {
  const w = new BinaryWriter(64);
  writeHeader(w, MessageType.Error, SCHEMA_VERSION);
  w.u16(p.code & 0xffff);
  w.string(p.message);
  return w.finish();
}

export function decode(r: BinaryReader): ErrorPayload {
  const code = r.u16();
  const message = r.string();
  return { code, message };
}
