import { SCHEMA_VERSION } from '../../constants.js';
import type { HelloPayload } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: HelloPayload): Uint8Array {
  const w = new BinaryWriter(64);
  writeHeader(w, MessageType.Hello, SCHEMA_VERSION);
  w.u32(p.schemaVersion);
  w.string(p.roomCode);
  w.string(p.name);
  return w.finish();
}

export function decode(r: BinaryReader): HelloPayload {
  const schemaVersion = r.u32();
  const roomCode = r.string();
  const name = r.string();
  return { schemaVersion, roomCode, name };
}
