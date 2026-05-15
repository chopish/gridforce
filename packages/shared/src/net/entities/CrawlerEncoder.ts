import type { CrawlerState, CrawlerAIStateValue } from '../../types.js';
import type { BinaryReader, BinaryWriter } from '../wire.js';
import { EntityType } from '../wire.js';
import type { EntityEncoder } from './PlayerEncoder.js';

const TWO_PI = Math.PI * 2;

function quantizeFacing(rad: number): number {
  let f = rad % TWO_PI;
  if (f < 0) f += TWO_PI;
  return Math.round((f / TWO_PI) * 256) & 0xff;
}
function unquantizeFacing(q: number): number {
  return (q / 256) * TWO_PI;
}

// Layout (10 bytes per Crawler):
//   u16 id       (2)
//   i16 x        (2)   px, rounded; world < 32768 px wide
//   i16 y        (2)   px, rounded
//   u8  facingQ  (1)   facing quantized 0..255
//   u8  hp       (1)   default 1 in B1
//   u8  targetCx (1)   grid column (u8)
//   u8  targetCy (1)   grid row (u8)
//   u8  ai       (1)   CrawlerAIState value
export const CrawlerEncoder: EntityEncoder<CrawlerState> = {
  type: EntityType.Crawler,
  encode(w: BinaryWriter, c: CrawlerState): void {
    w.u16(c.id & 0xffff);
    w.i16(Math.trunc(c.x));
    w.i16(Math.trunc(c.y));
    w.u8(quantizeFacing(c.facing));
    w.u8(c.hp & 0xff);
    w.u8(c.targetCx & 0xff);
    w.u8(c.targetCy & 0xff);
    w.u8(c.ai & 0xff);
  },
  decode(r: BinaryReader): CrawlerState {
    const id = r.u16();
    const x = r.i16();
    const y = r.i16();
    const facing = unquantizeFacing(r.u8());
    const hp = r.u8();
    const targetCx = r.u8();
    const targetCy = r.u8();
    const ai = r.u8() as CrawlerAIStateValue;
    return { id, x, y, facing, hp, targetCx, targetCy, ai };
  },
};
