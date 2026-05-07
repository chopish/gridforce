import { SCHEMA_VERSION } from '../../constants.js';
import type { SetReadyPayload } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: SetReadyPayload): Uint8Array {
  const w = new BinaryWriter(8);
  writeHeader(w, MessageType.SetReady, SCHEMA_VERSION);
  w.u8(p.ready ? 1 : 0);
  return w.finish();
}

export function decode(r: BinaryReader): SetReadyPayload {
  const ready = r.u8() !== 0;
  return { ready };
}
