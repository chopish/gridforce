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

// One player entity = 15 bytes:
//   u8  id            (1)
//   f32 x             (4)
//   f32 y             (4)
//   u8  facingQ       (1)
//   u8  flags         (1)
//   u32 stateSeq      (4)
//
// Dash timer fields (cooldown/remaining) are server-private and reconstructed
// on the client from `flags & DASHING` plus client-side prediction. They are
// not on the wire to keep snapshots small; the visible effect (dash motion)
// is captured by the velocity inferred from successive snapshots.
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
    w.u32(p.stateSeq >>> 0);
  },
  decode(r) {
    const id = r.u8();
    const x = r.f32();
    const y = r.f32();
    const facing = unquantizeFacing(r.u8());
    const flags = r.u8();
    const stateSeq = r.u32();
    // Wire-side reconstruction of timers: clients only know "is dashing",
    // not how much time is left. That's fine — the prediction sim runs its
    // own timers and reconciliation rebases on next snapshot.
    return {
      id,
      x,
      y,
      facing,
      dashCooldownS: 0,
      dashRemainingS: (flags & PLAYER_FLAG_DASHING) !== 0 ? 0.001 : 0,
      stateSeq,
    };
  },
};
