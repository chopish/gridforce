import { SCHEMA_VERSION } from '../../constants.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

// AddBot has no payload — it's a pure command. Encoded form is just the
// header. The empty record type makes that explicit.
export type AddBotPayload = Record<string, never>;

export function encode(_p: AddBotPayload = {}): Uint8Array {
  const w = new BinaryWriter(8);
  writeHeader(w, MessageType.AddBot, SCHEMA_VERSION);
  return w.finish();
}

export function decode(): AddBotPayload {
  return {};
}
