import { SCHEMA_VERSION } from '../../constants.js';
import { encodeRle, decodeRle } from '../../panels.js';
import { RoomPhaseValue, type CrawlerState, type NpcState, type PlayerState, type RoomPhase, type SnapshotPayload } from '../../types.js';
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
//   u8  phase                (0=lobby, 1=playing, 2=run-end)
//   u8  hostId               (0xff if no human host)
//   u8  difficulty           (DifficultyValue enum)
//   string runId
//   u8  currentStageIndex
//   u8  currentPhaseIndex
//   f32 phaseElapsedS
//   u8  groupCount
//   for each group:
//     u8 entityType
//     varuint count
//     [entityType-specific payload]
function encodePhase(p: RoomPhase): number {
  if (p === 'playing') return RoomPhaseValue.Playing;
  if (p === 'run-end') return RoomPhaseValue.RunEnd;
  return RoomPhaseValue.Lobby;
}

function decodePhase(v: number): RoomPhase {
  if (v === RoomPhaseValue.Playing) return 'playing';
  if (v === RoomPhaseValue.RunEnd) return 'run-end';
  return 'lobby';
}

export function encode(p: SnapshotPayload): Uint8Array {
  const w = new BinaryWriter(256);
  writeHeader(w, MessageType.Snapshot, SCHEMA_VERSION);
  w.u32(p.tick >>> 0);
  w.f64(p.serverTimeMs);
  w.i32(p.ackInputTick | 0);
  w.u32(p.inputAckBitmask >>> 0);
  w.u8(encodePhase(p.phase));
  w.u8(p.hostId & 0xff);
  w.u8(p.difficulty & 0xff);
  w.string(p.runId);
  w.u8(p.currentStageIndex & 0xff);
  w.u8(p.currentPhaseIndex & 0xff);
  w.f32(p.phaseElapsedS);
  w.u16(p.panelCols);
  w.u16(p.panelRows);
  encodeRle(w, p.panelStates);

  // Group count is dynamic — Player is always present; NPC and Crawler
  // groups are omitted when empty (saves the 2-byte group header each).
  const hasNpcs = p.npcs.length > 0;
  const hasCrawlers = p.crawlers.length > 0;
  let groupCount = 1; // Player always present
  if (hasNpcs) groupCount++;
  if (hasCrawlers) groupCount++;
  w.u8(groupCount);
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
  if (hasCrawlers) {
    w.u8(EntityType.Crawler);
    w.varuint(p.crawlers.length);
    const crawlerEnc = getEntityEncoder(EntityType.Crawler);
    if (!crawlerEnc) throw new Error('Crawler encoder not registered');
    for (const c of p.crawlers) crawlerEnc.encode(w, c);
  }

  return w.finish();
}

export function decode(r: BinaryReader): SnapshotPayload {
  const tick = r.u32();
  const serverTimeMs = r.f64();
  const ackInputTick = r.i32();
  const inputAckBitmask = r.u32();
  const phase = decodePhase(r.u8());
  const hostId = r.u8();
  const difficulty = r.u8();
  const runId = r.string();
  const currentStageIndex = r.u8();
  const currentPhaseIndex = r.u8();
  const phaseElapsedS = r.f32();
  const panelCols = r.u16();
  const panelRows = r.u16();
  const panelStates = decodeRle(r, panelCols * panelRows);

  const groupCount = r.u8();
  const players: PlayerState[] = [];
  const npcs: NpcState[] = [];
  const crawlers: CrawlerState[] = [];
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
    } else if (entityType === EntityType.Crawler) {
      for (let i = 0; i < count; i++) crawlers.push(enc.decode(r) as CrawlerState);
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
    runId,
    currentStageIndex,
    currentPhaseIndex,
    phaseElapsedS,
    panelStates,
    panelCols,
    panelRows,
    players,
    npcs,
    crawlers,
  };
}
