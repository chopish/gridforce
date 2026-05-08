import type { NpcState } from '../../types.js';
import { BinaryReader, BinaryWriter, EntityType } from '../wire.js';
import type { EntityEncoder } from './PlayerEncoder.js';

// One NPC = 8 bytes:
//   u16 id              (2)
//   i16 x               (2)   px precision; world < 32768 px wide
//   i16 y               (2)   px precision
//   u8  facingQ         (1)   facing quantized 0..255
//   u8  flags           (1)   bits reserved for AI mode / hp / etc.
//
// Position is i16 + 1px precision because at 300+ NPCs even saving 4
// bytes per entity is real bandwidth (300 × 4 × 20 Hz = 24 KB/s). The
// 1-pixel discretization is well below visual perceptibility for
// entities the player isn't intimately tracking.

const TWO_PI = Math.PI * 2;

function quantizeFacing(rad: number): number {
  let f = rad % TWO_PI;
  if (f < 0) f += TWO_PI;
  return Math.round((f / TWO_PI) * 256) & 0xff;
}
function unquantizeFacing(q: number): number {
  return (q / 256) * TWO_PI;
}

function clampI16(v: number): number {
  if (v < -32768) return -32768;
  if (v > 32767) return 32767;
  return v | 0;
}

export const NpcEncoder: EntityEncoder<NpcState> = {
  type: EntityType.NPC,
  encode(w: BinaryWriter, n: NpcState): void {
    w.u16(n.id & 0xffff);
    w.i16(clampI16(Math.round(n.x)));
    w.i16(clampI16(Math.round(n.y)));
    w.u8(quantizeFacing(n.facing));
    w.u8(n.flags & 0xff);
  },
  decode(r: BinaryReader): NpcState {
    const id = r.u16();
    const x = r.i16();
    const y = r.i16();
    const facing = unquantizeFacing(r.u8());
    const flags = r.u8();
    return { id, x, y, facing, flags };
  },
};
