import { SCHEMA_VERSION } from '../../constants.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

export interface AddBotPayload {}

export function encode(_p: AddBotPayload): Uint8Array {
  const w = new BinaryWriter(8);
  writeHeader(w, MessageType.AddBot, SCHEMA_VERSION);
  return w.finish();
}

export function decode(): AddBotPayload {
  return {};
}
