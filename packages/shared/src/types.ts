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

export interface SnapshotPayload {
  tick: number;
  serverTimeMs: number;
  ackInputTick: number;
  inputAckBitmask: number;
  players: PlayerState[];
}

export interface WelcomePayload {
  yourPlayerId: PlayerId;
  grid: GridDef;
  startTick: number;
  serverTimeMs: number;
  players: PlayerState[];
}

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
