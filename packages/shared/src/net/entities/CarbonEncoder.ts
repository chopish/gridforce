import type { CarbonState } from '../../types.js';
import type { BinaryReader, BinaryWriter } from '../wire.js';
import { EntityType } from '../wire.js';
import type { EntityEncoder } from './PlayerEncoder.js';

// 7 bytes per pickup:
//   u16 id
//   i16 x   (rounded px)
//   i16 y   (rounded px)
//   u8  ttlQ   (0..255 mapping to 0..CARBON_TTL_S seconds)
//
// CARBON_TTL_S is the encoder's hardcoded max (10s). If that constant ever
// changes meaningfully, this encoder must follow.
const TTL_MAX_SECONDS = 10;
const TTL_SCALE = 255;

export const CarbonEncoder: EntityEncoder<CarbonState> = {
  type: EntityType.Carbon,
  encode(w: BinaryWriter, c: CarbonState): void {
    w.u16(c.id & 0xffff);
    w.i16(Math.round(c.x));
    w.i16(Math.round(c.y));
    const ttlQ = Math.max(0, Math.min(TTL_SCALE, Math.round((c.ttlS / TTL_MAX_SECONDS) * TTL_SCALE)));
    w.u8(ttlQ);
  },
  decode(r: BinaryReader): CarbonState {
    const id = r.u16();
    const x = r.i16();
    const y = r.i16();
    const ttlQ = r.u8();
    const ttlS = (ttlQ / TTL_SCALE) * TTL_MAX_SECONDS;
    return { id, x, y, ttlS };
  },
};
