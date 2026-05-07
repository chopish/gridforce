// Bump on ANY wire-format-incompatible change so a stale client can't
// silently misdecode a fresh server's snapshots (and vice versa). The Hello
// handshake compares this and emits an Error if they don't match.
//
// History:
//   v1: initial binary protocol
//   v2: PlayerEncoder gained dashCooldownS + dashRemainingS u8 quantized
export const SCHEMA_VERSION = 2;

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
export const PREDICTION_THRESHOLD_PX = 3;
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

// Frame stall safety on client (max dt fed into accumulator per render frame)
export const CLIENT_MAX_FRAME_DT_S = 0.05;
