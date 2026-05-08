import { SCHEMA_VERSION } from '../../constants.js';
import type { RtcOfferPayload } from '../../types.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: RtcOfferPayload): Uint8Array {
  const w = new BinaryWriter(2048);
  writeHeader(w, MessageType.RtcOffer, SCHEMA_VERSION);
  w.string(p.sdp);
  return w.finish();
}

export function decode(r: BinaryReader): RtcOfferPayload {
  const sdp = r.string();
  return { sdp };
}
