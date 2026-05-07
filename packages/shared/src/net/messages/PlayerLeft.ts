import { SCHEMA_VERSION } from '../../constants.js';
import type { PlayerLeftPayload } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: PlayerLeftPayload): Uint8Array {
  const w = new BinaryWriter(8);
  writeHeader(w, MessageType.PlayerLeft, SCHEMA_VERSION);
  w.u8(p.playerId & 0xff);
  return w.finish();
}

export function decode(r: BinaryReader): PlayerLeftPayload {
  const playerId = r.u8();
  return { playerId };
}
