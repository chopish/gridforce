import { SCHEMA_VERSION } from '../../constants.js';
import type { PlayerState, SnapshotPayload } from '../../types.js';
import { getEntityEncoder, registerEntityEncoder } from '../entities/registry.js';
import { BinaryReader, BinaryWriter, EntityType, MessageType, writeHeader } from '../wire.js';

// Ensure registry is initialised whenever Snapshot is loaded.
// (Safe / idempotent — Map.set with same key is a no-op.)
void registerEntityEncoder;

// Snapshot layout:
//   u32 tick
//   f64 serverTimeMs
//   i32 ackInputTick
//   u32 inputAckBitmask
//   u8  groupCount
//   for each group:
//     u8 entityType
//     varuint count
//     [entityType-specific payload]
export function encode(p: SnapshotPayload): Uint8Array {
  const w = new BinaryWriter(256);
  writeHeader(w, MessageType.Snapshot, SCHEMA_VERSION);
  w.u32(p.tick >>> 0);
  w.f64(p.serverTimeMs);
  w.i32(p.ackInputTick | 0);
  w.u32(p.inputAckBitmask >>> 0);

  // Phase 0: just the player group.
  w.u8(1);
  w.u8(EntityType.Player);
  w.varuint(p.players.length);
  const enc = getEntityEncoder(EntityType.Player);
  if (!enc) throw new Error('Player encoder not registered');
  for (const pl of p.players) enc.encode(w, pl);

  return w.finish();
}

export function decode(r: BinaryReader): SnapshotPayload {
  const tick = r.u32();
  const serverTimeMs = r.f64();
  const ackInputTick = r.i32();
  const inputAckBitmask = r.u32();

  const groupCount = r.u8();
  const players: PlayerState[] = [];
  for (let g = 0; g < groupCount; g++) {
    const entityType = r.u8();
    const count = r.varuint();
    const enc = getEntityEncoder(entityType);
    if (!enc) {
      // Unknown entity group → we cannot know its payload size, so we cannot
      // skip past it without an explicit framed size. For Phase 0, treat this
      // as a hard error; we'll add a size prefix per group when we add types.
      throw new RangeError(`Unknown entity type ${entityType} in snapshot`);
    }
    if (entityType === EntityType.Player) {
      for (let i = 0; i < count; i++) players.push(enc.decode(r) as PlayerState);
    } else {
      for (let i = 0; i < count; i++) enc.decode(r);
    }
  }

  return { tick, serverTimeMs, ackInputTick, inputAckBitmask, players };
}
