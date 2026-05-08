import { SCHEMA_VERSION } from '../../constants.js';
import type { RtcAnswerPayload } from '../../types.js';
import { BinaryReader, BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: RtcAnswerPayload): Uint8Array {
  const w = new BinaryWriter(2048);
  writeHeader(w, MessageType.RtcAnswer, SCHEMA_VERSION);
  w.string(p.sdp);
  return w.finish();
}

export function decode(r: BinaryReader): RtcAnswerPayload {
  const sdp = r.string();
  return { sdp };
}
