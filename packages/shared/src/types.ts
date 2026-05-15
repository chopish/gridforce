export type PlayerId = number;

export interface PlayerInput {
  tick: number;
  clientTimeMs: number;
  mx: number;
  my: number;
  dash: boolean;
  sprint: boolean;
  shock: boolean;
  repair: boolean;
}

// Wandering NPC. Phase 0 has no combat or pathing — these are bouncing
// walkers used to stress the netcode (300+ entities sharing snapshot
// bandwidth + tick budget). When the actual game ships they'll grow
// state for AI mode, target, hp, etc.; the encoder is laid out with
// spare flag bits so we can extend without another schema bump.
export interface NpcState {
  id: number;
  x: number;
  y: number;
  facing: number;
  flags: number;
}

export interface PlayerState {
  id: PlayerId;
  x: number;
  y: number;
  facing: number;
  panelJumpCooldownS: number; // renamed from dashCooldownS
  // dashRemainingS removed — panel-jump is instantaneous
  stateSeq: number;
  // Roster metadata. Lives on PlayerState for wire-format simplicity in
  // Phase 0 — stepPlayer treats them as opaque pass-through. When the
  // entity registry grows beyond Player we can split sim state from
  // roster meta into separate snapshot groups.
  name: string;
  ready: boolean;
  carbon: number;           // 0..99
  shockCooldownS: number;   // 0..SHOCK_COOLDOWN_S
  repairProgressS: number;  // 0..REPAIR_DURATION_S
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

// Room phase. 'lobby' = pre-game ready-up; 'playing' = sim runs; 'run-end'
// = the final stage's final phase has elapsed and the run is over (clients
// show a "Run Complete" panel; the room sits here until torn down).
// Wire encoding: u8 with values matching RoomPhaseValue below.
export type RoomPhase = 'lobby' | 'playing' | 'run-end';
export const RoomPhaseValue = {
  Lobby: 0,
  Playing: 1,
  RunEnd: 2,
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
  // Pre-game selections. Carried in every snapshot so a late-joining
  // client gets them on first delivery without a separate sync message.
  // Snapshot-rate cost is ~12 bytes/snap which is negligible.
  difficulty: number; // DifficultyValue
  runId: string;
  // Index into the active run's stageSequence. 0 in lobby.
  currentStageIndex: number;
  // Index into the active stage's phaseSequence. 0 in lobby.
  currentPhaseIndex: number;
  // Seconds elapsed in the current phase. 0 in lobby; resets on each phase
  // entry. Combined with PhaseDef.durationS this drives the StageHud
  // countdown without any extra messages.
  phaseElapsedS: number;
  players: PlayerState[];
  // Wandering NPCs (entity stress / forward-design slot for game NPCs).
  // Empty when none are spawned. Per-NPC cost on the wire is ~8 bytes,
  // so 100 NPCs ≈ 16 KB/s downstream — over the 8 KB/s Phase 0 budget,
  // but the budget is for the empty-room case; entity load is the lever
  // AOI will eventually claw back.
  npcs: NpcState[];
}

export interface WelcomePayload {
  yourPlayerId: PlayerId;
  grid: GridDef;
  startTick: number;
  serverTimeMs: number;
  phase: RoomPhase;
  hostId: PlayerId;
  difficulty: number;
  runId: string;
  // Active run's current position. Mirrors the snapshot fields so a late
  // joiner doesn't have to wait a snapshot tick to know where they are.
  currentStageIndex: number;
  currentPhaseIndex: number;
  phaseElapsedS: number;
  // Cap on humans + bots in this room. Static for the room's lifetime.
  // Surfaced to the client so the lobby UI can show "X/N" and bound the
  // invite-uses dropdown without a separate /api round-trip.
  maxPlayers: number;
  players: PlayerState[];
  // Per-connection bearer token. The client stores it and sends as
  // `Authorization: Bearer <sessionKey>` on host-gated HTTP endpoints
  // (invite creation, future room settings). Sent only inside this
  // player's Welcome — never broadcast to others.
  sessionKey: string;
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
export type StartGamePayload = Record<string, never>;

// Host-only mid-lobby tweak. Server validates that the sender is the
// current hostId, that runId is in the RUNS list, and that difficulty
// is a known enum value before applying.
export interface SetLobbySettingsPayload {
  runId: string;
  difficulty: number;
}

// Host-only stress-test command. Server adjusts the room's NPC count
// up or down to match `count`, clamping to a reasonable cap.
export interface SetNpcCountPayload {
  count: number;
}

// WebRTC DataChannel signalling, all carried over the existing WS
// control plane. Server is the offerer (it creates the data channel
// and triggers libdatachannel's auto-negotiation), client answers.
// Each payload carries one piece of SDP / ICE; RtcIce can fire many
// times during gathering on both sides via trickle.
export interface RtcOfferPayload {
  sdp: string;
}
export interface RtcAnswerPayload {
  sdp: string;
}
export interface RtcIcePayload {
  candidate: string;
  mid: string;
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
