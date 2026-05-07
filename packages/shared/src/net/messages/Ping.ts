import { SCHEMA_VERSION } from '../../constants.js';
import type { PingPayload } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: PingPayload): Uint8Array {
  const w = new BinaryWriter(16);
  writeHeader(w, MessageType.Ping, SCHEMA_VERSION);
  w.u32(p.nonce >>> 0);
  w.f64(p.clientTimeMs);
  return w.finish();
}

export function decode(r: BinaryReader): PingPayload {
  const nonce = r.u32();
  const clientTimeMs = r.f64();
  return { nonce, clientTimeMs };
}
