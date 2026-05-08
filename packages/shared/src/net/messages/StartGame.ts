import { SCHEMA_VERSION } from '../../constants.js';
import type { StartGamePayload } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(_p: StartGamePayload = {}): Uint8Array {
  const w = new BinaryWriter(8);
  writeHeader(w, MessageType.StartGame, SCHEMA_VERSION);
  return w.finish();
}

export function decode(_r: BinaryReader): StartGamePayload {
  return {};
}
