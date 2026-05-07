export type PlayerId = number;

export interface PlayerInput {
  tick: number;
  clientTimeMs: number;
  mx: number;
  my: number;
  dash: boolean;
}

export interface PlayerState {
  id: PlayerId;
  x: number;
  y: number;
  facing: number;
  dashCooldownS: number;
  dashRemainingS: number;
  stateSeq: number;
  // Roster metadata. Lives on PlayerState for wire-format simplicity in
  // Phase 0 — stepPlayer treats them as opaque pass-through. When the
  // entity registry grows beyond Player we can split sim state from
  // roster meta into separate snapshot groups.
  name: string;
  ready: boolean;
}

export interface GridDef {
  cols: number;
  rows: number;
  panelSize: number;
}

export interface WorldState {
  tick: number;
  players: PlayerState[];
}

// Room phase. 'lobby' = pre-game ready-up; 'playing' = sim runs.
// Wire encoding: u8 with values matching RoomPhaseValue below.
export type RoomPhase = 'lobby' | 'playing';
export const RoomPhaseValue = {
  Lobby: 0,
  Playing: 1,
} as const;

export interface SnapshotPayload {
  tick: number;
  serverTimeMs: number;
  ackInputTick: number;
  inputAckBitmask: number;
  // u8 over the wire; the client mirrors this into UI state and gates
  // input capture / movement on transitions.
  phase: RoomPhase;
  // PlayerId of the host, or 0xff if no human host yet (room is empty or
  // only contains bots — bots never become host).
  hostId: PlayerId;
  players: PlayerState[];
}

export interface WelcomePayload {
  yourPlayerId: PlayerId;
  grid: GridDef;
  startTick: number;
  serverTimeMs: number;
  phase: RoomPhase;
  hostId: PlayerId;
  players: PlayerState[];
}

// Lobby controls. Sent by the client.
//
// SetReady toggles the joiner's ready flag in the room's roster.
// StartGame is host-only; server validates and rejects if the sender isn't
// the current host. Both messages have empty payloads (the sender's id is
// known from the connection).
export interface SetReadyPayload {
  ready: boolean;
}

// Empty payload — host gating is enforced server-side from the connection's
// playerId, not from any field the client could spoof.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface StartGamePayload {}

export interface HelloPayload {
  schemaVersion: number;
  roomCode: string;
  name: string;
  // Short-lived bearer issued by HTTP /invites/:token/redeem (private rooms)
  // or /rooms/:code/access (public/unlisted). Empty string is rejected for
  // private rooms; allowed for public/unlisted to keep invite-less joins
  // possible during dev.
  accessKey: string;
}

export interface PingPayload {
  nonce: number;
  clientTimeMs: number;
}

export interface PongPayload {
  nonce: number;
  clientTimeMs: number;
  serverTimeMs: number;
}

export interface ErrorPayload {
  code: number;
  message: string;
}

export interface PlayerJoinedPayload {
  player: PlayerState;
}

export interface PlayerLeftPayload {
  playerId: PlayerId;
}

export const ErrorCode = {
  SchemaMismatch: 1,
  RoomFull: 2,
  RoomNotFound: 3,
  AccessDenied: 4,
  Internal: 99,
} as const;
