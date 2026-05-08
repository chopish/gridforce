import { SCHEMA_VERSION } from '../../constants.js';
import type { RtcIcePayload } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: RtcIcePayload): Uint8Array {
  const w = new BinaryWriter(512);
  writeHeader(w, MessageType.RtcIce, SCHEMA_VERSION);
  w.string(p.candidate);
  w.string(p.mid);
  return w.finish();
}

export function decode(r: BinaryReader): RtcIcePayload {
  const candidate = r.string();
  const mid = r.string();
  return { candidate, mid };
}
