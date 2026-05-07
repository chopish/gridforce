import { SCHEMA_VERSION } from '../../constants.js';
import type { PlayerJoinedPayload, PlayerState } from '../../types.js';
import { PlayerEncoder } from '../entities/PlayerEncoder.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: PlayerJoinedPayload): Uint8Array {
  const w = new BinaryWriter(32);
  writeHeader(w, MessageType.PlayerJoined, SCHEMA_VERSION);
  PlayerEncoder.encode(w, p.player);
  return w.finish();
}

export function decode(r: BinaryReader): PlayerJoinedPayload {
  const player = PlayerEncoder.decode(r) as PlayerState;
  return { player };
}
