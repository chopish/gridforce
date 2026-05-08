import { SCHEMA_VERSION } from '../../constants.js';
import type { PlayerState, WelcomePayload } from '../../types.js';
import { PlayerEncoder } from '../entities/PlayerEncoder.js';
import type { BinaryReader } from '../wire.js';
import { BinaryWriter, MessageType, writeHeader } from '../wire.js';

export function encode(p: WelcomePayload): Uint8Array {
  const w = new BinaryWriter(128);
  writeHeader(w, MessageType.Welcome, SCHEMA_VERSION);
  w.u8(p.yourPlayerId & 0xff);
  w.u16(p.grid.cols);
  w.u16(p.grid.rows);
  w.u16(p.grid.panelSize);
  w.u32(p.startTick >>> 0);
  w.f64(p.serverTimeMs);
  w.u8(p.phase === 'playing' ? 1 : 0);
  w.u8(p.hostId & 0xff);
  w.u8(p.difficulty & 0xff);
  w.string(p.levelId);
  w.u8(p.maxPlayers & 0xff);
  w.string(p.sessionKey);
  w.varuint(p.players.length);
  for (const pl of p.players) PlayerEncoder.encode(w, pl);
  return w.finish();
}

export function decode(r: BinaryReader): WelcomePayload {
  const yourPlayerId = r.u8();
  const cols = r.u16();
  const rows = r.u16();
  const panelSize = r.u16();
  const startTick = r.u32();
  const serverTimeMs = r.f64();
  const phase: 'lobby' | 'playing' = r.u8() === 1 ? 'playing' : 'lobby';
  const hostId = r.u8();
  const difficulty = r.u8();
  const levelId = r.string();
  const maxPlayers = r.u8();
  const sessionKey = r.string();
  const count = r.varuint();
  const players: PlayerState[] = [];
  for (let i = 0; i < count; i++) players.push(PlayerEncoder.decode(r));
  return {
    yourPlayerId,
    grid: { cols, rows, panelSize },
    startTick,
    serverTimeMs,
    phase,
    hostId,
    difficulty,
    levelId,
    maxPlayers,
    sessionKey,
    players,
  };
}
