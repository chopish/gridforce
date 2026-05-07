import type { PlayerState } from '../../types.js';
import { BinaryReader, BinaryWriter, EntityType } from '../wire.js';

// Player flags packed into one byte, header for forward extension.
export const PLAYER_FLAG_DASHING = 1 << 0;
// bits 1..6 reserved
// bit 7 reserved as "delta-from-baseline" marker for future delta encoding.

const TWO_PI = Math.PI * 2;

function quantizeFacing(rad: number): number {
  // Wrap to [0, 2π) then map to 0..255.
  let f = rad % TWO_PI;
  if (f < 0) f += TWO_PI;
  return Math.round((f / TWO_PI) * 256) & 0xff;
}

function unquantizeFacing(q: number): number {
  return (q / 256) * TWO_PI;
}

// One player entity = 17 bytes:
//   u8  id              (1)
//   f32 x               (4)
//   f32 y               (4)
//   u8  facingQ         (1)
//   u8  flags           (1)
//   u8  dashCooldownQ   (1)   seconds × 255, saturating at 1.0s
//   u8  dashRemainingQ  (1)   seconds × 255, saturating at 1.0s
//   u32 stateSeq        (4)
//
// The two timers MUST be on the wire. Without them, every snapshot resets
// the client's view of cooldown/remaining to zero, which lets the client
// predict a fresh dash after every snapshot tick — the server (which still
// has real cooldown elapsing) rejects it, and the player rubber-bands.
const TIMER_SCALE = 255; // 1 second resolved at ~3.9 ms per step

function quantizeTimer(s: number): number {
  if (s <= 0) return 0;
  const q = Math.round(s * TIMER_SCALE);
  return q >= 255 ? 255 : q;
}
function unquantizeTimer(q: number): number {
  return q / TIMER_SCALE;
}

export interface EntityEncoder<T> {
  type: EntityType;
  encode(w: BinaryWriter, entity: T): void;
  decode(r: BinaryReader): T;
}

export const PlayerEncoder: EntityEncoder<PlayerState> = {
  type: EntityType.Player,
  encode(w, p) {
    w.u8(p.id & 0xff);
    w.f32(p.x);
    w.f32(p.y);
    w.u8(quantizeFacing(p.facing));
    let flags = 0;
    if (p.dashRemainingS > 0) flags |= PLAYER_FLAG_DASHING;
    w.u8(flags);
    w.u8(quantizeTimer(p.dashCooldownS));
    w.u8(quantizeTimer(p.dashRemainingS));
    w.u32(p.stateSeq >>> 0);
  },
  decode(r) {
    const id = r.u8();
    const x = r.f32();
    const y = r.f32();
    const facing = unquantizeFacing(r.u8());
    const flags = r.u8();
    const dashCooldownS = unquantizeTimer(r.u8());
    const dashRemainingS = unquantizeTimer(r.u8());
    const stateSeq = r.u32();
    // The DASHING flag is redundant with dashRemainingS > 0; we keep it for
    // forward extensibility (other state bits can ride along) and so the
    // renderer can do a one-byte check without unquantizing the timer.
    void flags;
    return { id, x, y, facing, dashCooldownS, dashRemainingS, stateSeq };
  },
};
