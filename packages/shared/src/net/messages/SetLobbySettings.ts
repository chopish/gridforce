import { SCHEMA_VERSION } from '../../constants.js';
import type { SetLobbySettingsPayload } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: SetLobbySettingsPayload): Uint8Array {
  const w = new BinaryWriter(48);
  writeHeader(w, MessageType.SetLobbySettings, SCHEMA_VERSION);
  w.u8(p.difficulty & 0xff);
  w.string(p.runId);
  return w.finish();
}

export function decode(r: BinaryReader): SetLobbySettingsPayload {
  const difficulty = r.u8();
  const runId = r.string();
  return { difficulty, runId };
}
