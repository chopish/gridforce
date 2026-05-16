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
//  v10: Run/Stage/Phase framework. Snapshot/Welcome/SetLobbySettings
//       rename `levelId` → `runId`. Snapshot + Welcome additionally
//       carry currentStageIndex (u8), currentPhaseIndex (u8), and
//       phaseElapsedS (f32). RoomPhase gains a third value `run-end`
//       (encoded as u8 = 2) for the post-final-phase state.
//  v11: PlayerInput gains a `sprint` bit (held shift). PlayerEncoder
//       drops dashRemainingS (panel-jump is instantaneous) and renames
//       dashCooldownS → panelJumpCooldownS. The `dash` input bit is
//       still wire-named `dash` but now means "rising-edge panel jump".
//  v12: First-playable B1. PlayerInput adds `shock` + `repair` bits.
//       PlayerState adds carbon + shockCooldownS + repairProgressS.
//       Snapshot carries a panel-state RLE block, plus new entity
//       groups EntityType.Crawler=3 and EntityType.Carbon=4. Welcome
//       carries the full panel-state byte array. v13 (B2) will add
//       hp/downed/reviveProgress + cityHp + currentWave + counters.
//  v13: Layered tiles + priority-AI foundation. PlayerInput drops `dash`
//       and `sprint`, adds `jumpHeld` + `jumpCursorDx/Dy` (i8 ±2) +
//       `facingRadQ` (u8 cursor-derived facing). Shock becomes held-state.
//       PlayerState adds `facingCursorRad` (cursor-derived, distinct from
//       velocity-derived facing) and `shockHeldS`. Snapshot/Welcome
//       replace the single `panelStates` RLE block with four per-layer
//       byte buffers (l0Hp, l1Hp, l2Kind, l2Hp), RLE-encoded in snapshot
//       and raw in welcome.
export const SCHEMA_VERSION = 13;

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

// Player movement. Sprint was retired in v13; default walk speed is bumped
// to roughly the previous sprint speed so the larger arena still feels
// traversable. Tactical bursts of speed now come from panel-jump.
export const PLAYER_RADIUS = 12;
export const PLAYER_MOVE_SPEED = 308; // was 220; 220 * 1.4 ≈ 308

// Panel-jump: in v13, the falling-edge of `jumpHeld` (Shift-release) teleports
// the player toward `jumpCursor{Dx,Dy}` (server-authoritative; see Room.ts).
// Cooldown is the rate-limit and is decremented in shared sim.ts.
export const PANEL_JUMP_COOLDOWN_S = 0.4;

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
// Sized in v13 for PLAYER_MOVE_SPEED=308 (was 30 when speed was 220 in v12).
// Per-tick prediction error scales with movement speed; 42 ≈ 30 × 308/220.
export const PREDICTION_HARD_SNAP_PX = 42;
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

// --- B1 electrical-defense tuning (placeholders, expect playtest changes) ---

// Repair (DAMAGED -> LIVE only in B1; rebuild lands in B2).
export const REPAIR_DURATION_S = 1.5;
export const REPAIR_CARBON_COST = 1;

// Uncharged local shock (charged shock lands in B2).
export const SHOCK_COOLDOWN_S = 0.25;

// Carbon pickups.
export const CARBON_TTL_S = 10;
export const CARBON_PICKUP_RADIUS = 16;
export const PLAYER_CARBON_MAX = 99;

// Crawlers.
export const CRAWLER_MOVE_SPEED = 80;        // px/s
export const CRAWLER_RADIUS = 14;            // px
export const CRAWLER_SPAWN_INTERVAL_S = 1.0; // continuous trickle in B1
export const MAX_ALIVE_CRAWLERS = 8;         // B1 cap; B2 wave manager raises this

// --- C1 layered-tiles & priority-AI tuning (placeholders, expect playtest changes) ---

// Layer HP / armor.
export const L0_DOME_MAX_HP = 200;
export const L1_PANEL_MAX_HP = 100;
export const L2_ADDON_DEFAULT_MAX_HP = 60; // unused until C1's addon catalog ships
export const TILE_LAYER_ARMOR_MAX = 100;

// Weight integrity.
export const WEIGHT_THRESHOLD = 4;
export const BASE_DOT_RATE = 2; // hp/s per unit weight (linear regime)

// Conduction (panel HP fraction at/above which L1 conducts shock).
export const CONDUCTION_THRESHOLD = 0.5;

// Crawler weight contribution (canonical mite-equivalent in C1).
export const CRAWLER_WEIGHT = 1;

// Charged shock.
export const SHOCK_CHARGE_TIME_S = 0.6;
export const SHOCK_CHARGE_COOLDOWN_S = 0.5;

// Camera (defaults; settings UI is a future spec).
export const CAMERA_ZOOM_MIN = 0.5;
export const CAMERA_ZOOM_MAX = 2.0;
export const CAMERA_ZOOM_STEP = 1.1; // per scroll notch
export const CAMERA_FOLLOW_SMOOTH_S = 0.18;
export const CAMERA_EDGE_PAN_DEFAULT = false;
export const CAMERA_EDGE_PAN_BAND_PX = 40;
export const CAMERA_EDGE_PAN_SPEED_PX_S = 600;

// Minimap.
export const MINIMAP_SIZE_PX = 180;
export const MINIMAP_DANGER_WEIGHT_THRESHOLD = 3;

// Panel-jump targeting.
export const PANEL_JUMP_TARGET_RANGE = 2; // per-axis tile cap
