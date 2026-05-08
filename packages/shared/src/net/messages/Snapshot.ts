import { SCHEMA_VERSION } from '../../constants.js';
import type { NpcState, PlayerState, SnapshotPayload } from '../../types.js';
import { getEntityEncoder, registerEntityEncoder } from '../entities/registry.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, EntityType, MessageType, writeHeader } from '../wire.js';

// Ensure registry is initialised whenever Snapshot is loaded.
// (Safe / idempotent — Map.set with same key is a no-op.)
void registerEntityEncoder;

// Snapshot layout:
//   u32 tick
//   f64 serverTimeMs
//   i32 ackInputTick
//   u32 inputAckBitmask
//   u8  phase                (0=lobby, 1=playing)
//   u8  hostId               (0xff if no human host)
//   u8  difficulty           (DifficultyValue enum)
//   string levelId
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
  w.u8(p.phase === 'playing' ? 1 : 0);
  w.u8(p.hostId & 0xff);
  w.u8(p.difficulty & 0xff);
  w.string(p.levelId);

  // Group count is dynamic — Player is always present, NPC only when any
  // NPCs are spawned (saves the 2-byte group header in the empty case).
  const hasNpcs = p.npcs.length > 0;
  w.u8(hasNpcs ? 2 : 1);
  w.u8(EntityType.Player);
  w.varuint(p.players.length);
  const playerEnc = getEntityEncoder(EntityType.Player);
  if (!playerEnc) throw new Error('Player encoder not registered');
  for (const pl of p.players) playerEnc.encode(w, pl);
  if (hasNpcs) {
    w.u8(EntityType.NPC);
    w.varuint(p.npcs.length);
    const npcEnc = getEntityEncoder(EntityType.NPC);
    if (!npcEnc) throw new Error('NPC encoder not registered');
    for (const n of p.npcs) npcEnc.encode(w, n);
  }

  return w.finish();
}

export function decode(r: BinaryReader): SnapshotPayload {
  const tick = r.u32();
  const serverTimeMs = r.f64();
  const ackInputTick = r.i32();
  const inputAckBitmask = r.u32();
  const phase: 'lobby' | 'playing' = r.u8() === 1 ? 'playing' : 'lobby';
  const hostId = r.u8();
  const difficulty = r.u8();
  const levelId = r.string();

  const groupCount = r.u8();
  const players: PlayerState[] = [];
  const npcs: NpcState[] = [];
  for (let g = 0; g < groupCount; g++) {
    // u8 is a number on the wire; comparing against the EntityType enum
    // is safe because the enum is numeric and getEntityEncoder is the
    // gatekeeper for unknown values.
    const entityType = r.u8();
    const count = r.varuint();
    const enc = getEntityEncoder(entityType);
    if (!enc) {
      // Unknown entity group → we cannot know its payload size, so we cannot
      // skip past it without an explicit framed size. For Phase 0, treat this
      // as a hard error; we'll add a size prefix per group when we add types.
      throw new RangeError(`Unknown entity type ${entityType} in snapshot`);
    }
    /* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
    if (entityType === EntityType.Player) {
      for (let i = 0; i < count; i++) players.push(enc.decode(r) as PlayerState);
    } else if (entityType === EntityType.NPC) {
      for (let i = 0; i < count; i++) npcs.push(enc.decode(r) as NpcState);
    } else {
      for (let i = 0; i < count; i++) enc.decode(r);
    }
    /* eslint-enable @typescript-eslint/no-unsafe-enum-comparison */
  }

  return {
    tick,
    serverTimeMs,
    ackInputTick,
    inputAckBitmask,
    phase,
    hostId,
    difficulty,
    levelId,
    players,
    npcs,
  };
}
