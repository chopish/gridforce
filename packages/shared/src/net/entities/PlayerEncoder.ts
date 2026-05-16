import type { PlayerState } from '../../types.js';
import type { BinaryReader, BinaryWriter } from '../wire.js';
import { EntityType } from '../wire.js';

// Player flags packed into one byte, header for forward extension.
export const PLAYER_FLAG_READY = 1 << 1;
// bit 0 reserved (was DASHING)
// bits 2..6 reserved
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

// One player entity (variable, ~21 + name bytes):
//   u8  id
//   f32 x
//   f32 y
//   u8  facingQ           (velocity-derived; legacy movement-animation cue)
//   u8  flags             bit1=READY
//   u8  panelJumpCooldownQ
//   u32 stateSeq
//   u8  carbon            (0..99 clamped)
//   u8  shockCooldownQ    (quantizeTimer; saturates at 1.0s)
//   u8  repairProgressQ   (quantizeLongTimer; saturates at ~2.0s for 1.5s repair window)
//   u8  facingCursorRadQ  (quantizeFacing; cursor-derived aim direction)
//   u8  shockHeldQ        (quantizeTimer; saturates at 1.0s, SHOCK_CHARGE_TIME_S is 0.6s)
//   string name
const TIMER_SCALE = 255; // 1 second resolved at ~3.9 ms per step (cooldowns)
// Longer-saturating scale for repair-style progress timers that can run
// past 1.0s (B1's REPAIR_DURATION_S = 1.5s; future actions may go longer).
// Saturates at 2.0s with ~7.8ms resolution per step — still plenty for a
// 30 Hz simulation.
const LONG_TIMER_SCALE = 127;

function quantizeTimer(s: number): number {
  if (s <= 0) return 0;
  const q = Math.round(s * TIMER_SCALE);
  return q >= 255 ? 255 : q;
}
function unquantizeTimer(q: number): number {
  return q / TIMER_SCALE;
}

function quantizeLongTimer(s: number): number {
  if (s <= 0) return 0;
  const q = Math.round(s * LONG_TIMER_SCALE);
  return q >= 255 ? 255 : q;
}
function unquantizeLongTimer(q: number): number {
  return q / LONG_TIMER_SCALE;
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
    if (p.ready) flags |= PLAYER_FLAG_READY;
    w.u8(flags);
    w.u8(quantizeTimer(p.panelJumpCooldownS));
    w.u32(p.stateSeq >>> 0);
    w.u8(Math.max(0, Math.min(99, p.carbon)) & 0xff);
    w.u8(quantizeTimer(p.shockCooldownS));
    w.u8(quantizeLongTimer(p.repairProgressS));
    w.u8(quantizeFacing(p.facingCursorRad));
    w.u8(quantizeTimer(p.shockHeldS)); // saturates at 1.0s — SHOCK_CHARGE_TIME_S is 0.6s
    w.string(p.name);
  },
  decode(r) {
    const id = r.u8();
    const x = r.f32();
    const y = r.f32();
    const facing = unquantizeFacing(r.u8());
    const flags = r.u8();
    const panelJumpCooldownS = unquantizeTimer(r.u8());
    const stateSeq = r.u32();
    const carbon = Math.min(99, r.u8());
    const shockCooldownS = unquantizeTimer(r.u8());
    const repairProgressS = unquantizeLongTimer(r.u8());
    const facingCursorRad = unquantizeFacing(r.u8());
    const shockHeldS = unquantizeTimer(r.u8());
    const name = r.string();
    const ready = (flags & PLAYER_FLAG_READY) !== 0;
    return { id, x, y, facing, facingCursorRad, panelJumpCooldownS, stateSeq, name, ready, carbon, shockCooldownS, repairProgressS, shockHeldS };
  },
};
