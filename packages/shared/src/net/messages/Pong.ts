import { SCHEMA_VERSION } from '../../constants.js';
import type { PongPayload } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: PongPayload): Uint8Array {
  const w = new BinaryWriter(24);
  writeHeader(w, MessageType.Pong, SCHEMA_VERSION);
  w.u32(p.nonce >>> 0);
  w.f64(p.clientTimeMs);
  w.f64(p.serverTimeMs);
  return w.finish();
}

export function decode(r: BinaryReader): PongPayload {
  const nonce = r.u32();
  const clientTimeMs = r.f64();
  const serverTimeMs = r.f64();
  return { nonce, clientTimeMs, serverTimeMs };
}
