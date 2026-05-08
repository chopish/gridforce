// Bump on ANY wire-format-incompatible change so a stale client can't
// silently misdecode a fresh server's snapshots (and vice versa). The Hello
// handshake compares this and emits an Error if they don't match.
//
// History:
//   v1: initial binary protocol
//   v2: PlayerEncoder gained dashCooldownS + dashRemainingS u8 quantized
//   v3: Hello carries accessKey for private-room invite redemption
//   v4: pre-game lobby phase — Snapshot/Welcome carry phase+hostId,
//       PlayerEncoder gained name string + READY flag bit, new SetReady
//       and StartGame client→server messages
//   v5: Welcome carries sessionKey so the host's client can authenticate
//       /api/rooms/:code/invites and other host-gated endpoints
//   v6: Snapshot + Welcome carry levelId (string) and difficulty (u8); new
//       SetLobbySettings client→server message lets the host adjust them
//       in the pre-game lobby
//   v7: Snapshot may include an NPC entity group (EntityType.NPC=2); new
//       SetNpcCount client→server message lets the host spawn / clear
//       wandering NPCs for stress testing
//   v8: Input message carries a list of recent inputs (redundancy), not
//       a single tick — the client sends the last N ticks in every frame
//       so a single dropped packet doesn't lose an input. Server dedupes
//       via existing tick check.
//   v9: WebRTC DataChannel signalling — three new messages (RtcOffer,
//       RtcAnswer, RtcIce) carry SDP + ICE between client and server
//       over the existing WebSocket. Snapshots/inputs migrate to the
//       DataChannel once it opens; WebSocket stays for control.
export const SCHEMA_VERSION = 9;

// Tick rates
export const SERVER_TICK_HZ = 30;
export const SERVER_TICK_DT_MS = 1000 / SERVER_TICK_HZ;
export const SERVER_TICK_DT_S = 1 / SERVER_TICK_HZ;

export const SERVER_SNAPSHOT_HZ = 20;
export const SERVER_SNAPSHOT_INTERVAL_MS = 1000 / SERVER_SNAPSHOT_HZ;

// Client prediction is locked to the server tick rate. Render runs at vsync
// and interpolates between the two most recent predicted states for visual
// smoothness — no separate "client prediction Hz" knob.
export const CLIENT_PREDICT_HZ = SERVER_TICK_HZ;
export const CLIENT_PREDICT_DT_MS = SERVER_TICK_DT_MS;
export const CLIENT_PREDICT_DT_S = SERVER_TICK_DT_S;

// Player movement
export const PLAYER_RADIUS = 12;
export const PLAYER_MOVE_SPEED = 220;
export const PLAYER_DASH_SPEED = 700;
export const PLAYER_DASH_DURATION_S = 0.18;
export const PLAYER_DASH_COOLDOWN_S = 0.65;
export const MAX_PLAYERS_PER_ROOM = 4;

// Grid (Phase 0: fixed-size empty grid)
export const PANEL_SIZE = 64;
export const GRID_COLS = 18;
export const GRID_ROWS = 12;
export const WORLD_WIDTH = PANEL_SIZE * GRID_COLS;
export const WORLD_HEIGHT = PANEL_SIZE * GRID_ROWS;

// Reconciliation
// Below threshold: no smooth correction is set; the rebase shifts the visual
// by at most ~5 px which is imperceptible at 60 fps. Set too low (e.g. 3) and
// every snapshot under jittery profiles fires a smooth correction whose
// 150 ms blend overlaps with the next, producing constant low-amplitude
// pulling that the HUD shows as `recon smooth=many` with `corr` ~1-2 px.
export const PREDICTION_THRESHOLD_PX = 5;
export const PREDICTION_HARD_SNAP_PX = 30;
export const PREDICTION_BLEND_MS = 150;

// Remote interpolation
export const REMOTE_INTERP_DELAY_MIN_MS = 80;
export const REMOTE_INTERP_DELAY_MAX_MS = 250;
export const REMOTE_INTERP_DELAY_SEED_MS = 100;
export const REMOTE_INTERP_DEAD_RECKON_MAX_MS = 200;
export const REMOTE_INTERP_CATCHUP_RATE = 1.05;

// Net
export const PING_INTERVAL_MS = 1000;
export const MAX_INPUT_BUFFER = 256;
export const MAX_REPLAY_INPUTS = 90;
export const ROOM_IDLE_PRUNE_MS = 60_000;
export const ROOM_CODE_LENGTH = 4;
// Client predicts this many ticks ahead of the server's most recent reported
// tick so that inputs arrive at the server before their target tick is
// processed. Sized for up to ~150 ms RTT (5 ticks × 33 ms = 165 ms).
export const INPUT_LEAD_TICKS = 5;
// How many recent inputs to pack into each Input message. 3 means each
// frame carries the latest input plus the previous two; under 10% loss
// the effective input miss-rate drops from 10% to ~0.1%. Bandwidth cost
// is small (~1 KB/s upstream at 30 Hz) and good connections see no
// downside since duplicates are dropped server-side via tick dedupe.
export const INPUT_REDUNDANCY = 3;
// Server-side cap on how many inputs we'll honour per Input message,
// regardless of what the client claims. Bounds parse cost and stops a
// hostile client from forcing an unbounded loop.
export const INPUT_MSG_MAX_COUNT = 16;
// Hard cap on adaptive input lead. An outlier RTT sample (e.g. from a
// backgrounded tab where pongs arrive seconds late) must not poison the
// lead and send all future inputs into the server's far future. 30 ticks
// covers RTTs up to ~2s; beyond that the game is unplayable anyway and we
// should be hard-resyncing instead of leaning further forward.
export const MAX_INPUT_LEAD_TICKS = 30;
// RTT samples above this are treated as pong-arrival outliers and skipped.
// Catches the case where a ping went out before the tab was hidden and the
// pong arrives seconds later when the tab returns.
export const RTT_OUTLIER_MS = 3000;

// Frame stall safety on client (max dt fed into accumulator per render frame)
export const CLIENT_MAX_FRAME_DT_S = 0.05;
