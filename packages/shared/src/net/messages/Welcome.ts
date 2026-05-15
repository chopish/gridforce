import { SCHEMA_VERSION } from '../../constants.js';
import { RoomPhaseValue, type PlayerState, type RoomPhase, type WelcomePayload } from '../../types.js';
import { PlayerEncoder } from '../entities/PlayerEncoder.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

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
  w.varuint(p.panelStates.length);
  for (let i = 0; i < p.panelStates.length; i++) w.u8(p.panelStates[i]!);
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
  const panelLen = r.varuint();
  const panelStates = new Uint8Array(panelLen);
  for (let i = 0; i < panelLen; i++) panelStates[i] = r.u8();
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
    panelStates,
  };
}
