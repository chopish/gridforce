import { SCHEMA_VERSION } from '../../constants.js';
import type { TileBuffers } from '../../tiles.js';
import { RoomPhaseValue, type PlayerState, type RoomPhase, type WelcomePayload } from '../../types.js';
import { PlayerEncoder } from '../entities/PlayerEncoder.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

// Welcome v13 wire layout (after header):
//   u8 yourPlayerId
//   u16 grid.cols, u16 grid.rows, u16 grid.panelSize
//   u32 startTick
//   f64 serverTimeMs
//   u8 phase
//   u8 hostId
//   u8 difficulty
//   string runId
//   u8 currentStageIndex, u8 currentPhaseIndex
//   f32 phaseElapsedS
//   u8 maxPlayers
//   string sessionKey
//   varuint playerCount, then [PlayerEncoder]*
//   varuint n (= cols*rows), then five raw u8[n] blocks in order:
//     l0Hp[n], l1Hp[n], l2Kind[n], l2Hp[n], l1Charge[n]   (v14)
// Raw (not RLE) to keep joiner-decode trivial; Welcome fires once per
// connection so the bandwidth difference vs. snapshot RLE is negligible.

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

export function encode(p: WelcomePayload): Uint8Array {
  const w = new BinaryWriter(128);
  writeHeader(w, MessageType.Welcome, SCHEMA_VERSION);
  w.u8(p.yourPlayerId & 0xff);
  w.u16(p.grid.cols);
  w.u16(p.grid.rows);
  w.u16(p.grid.panelSize);
  w.u32(p.startTick >>> 0);
  w.f64(p.serverTimeMs);
  w.u8(encodePhase(p.phase));
  w.u8(p.hostId & 0xff);
  w.u8(p.difficulty & 0xff);
  w.string(p.runId);
  w.u8(p.currentStageIndex & 0xff);
  w.u8(p.currentPhaseIndex & 0xff);
  w.f32(p.phaseElapsedS);
  w.u8(p.maxPlayers & 0xff);
  w.string(p.sessionKey);
  w.varuint(p.players.length);
  for (const pl of p.players) PlayerEncoder.encode(w, pl);
  const n = p.tiles.l0Hp.length;
  w.varuint(n);
  for (let i = 0; i < n; i++) w.u8(p.tiles.l0Hp[i]!);
  for (let i = 0; i < n; i++) w.u8(p.tiles.l1Hp[i]!);
  for (let i = 0; i < n; i++) w.u8(p.tiles.l2Kind[i]!);
  for (let i = 0; i < n; i++) w.u8(p.tiles.l2Hp[i]!);
  for (let i = 0; i < n; i++) w.u8(p.tiles.l1Charge[i]!);
  return w.finish();
}

export function decode(r: BinaryReader): WelcomePayload {
  const yourPlayerId = r.u8();
  const cols = r.u16();
  const rows = r.u16();
  const panelSize = r.u16();
  const startTick = r.u32();
  const serverTimeMs = r.f64();
  const phase = decodePhase(r.u8());
  const hostId = r.u8();
  const difficulty = r.u8();
  const runId = r.string();
  const currentStageIndex = r.u8();
  const currentPhaseIndex = r.u8();
  const phaseElapsedS = r.f32();
  const maxPlayers = r.u8();
  const sessionKey = r.string();
  const count = r.varuint();
  const players: PlayerState[] = [];
  for (let i = 0; i < count; i++) players.push(PlayerEncoder.decode(r));
  const n = r.varuint();
  const tiles: TileBuffers = {
    l0Hp: new Uint8Array(n),
    l1Hp: new Uint8Array(n),
    l2Kind: new Uint8Array(n),
    l2Hp: new Uint8Array(n),
    l1Charge: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) tiles.l0Hp[i] = r.u8();
  for (let i = 0; i < n; i++) tiles.l1Hp[i] = r.u8();
  for (let i = 0; i < n; i++) tiles.l2Kind[i] = r.u8();
  for (let i = 0; i < n; i++) tiles.l2Hp[i] = r.u8();
  for (let i = 0; i < n; i++) tiles.l1Charge[i] = r.u8();
  return {
    yourPlayerId,
    grid: { cols, rows, panelSize },
    startTick,
    serverTimeMs,
    phase,
    hostId,
    difficulty,
    runId,
    currentStageIndex,
    currentPhaseIndex,
    phaseElapsedS,
    maxPlayers,
    sessionKey,
    players,
    tiles,
  };
}
