import {
  INPUT_LEAD_TICKS,
  MAX_REPLAY_INPUTS,
  PREDICTION_BLEND_MS,
  PREDICTION_HARD_SNAP_PX,
  PREDICTION_THRESHOLD_PX,
  SERVER_TICK_DT_S,
  type GridDef,
  type PlayerId,
  type PlayerInput,
  type PlayerState,
  type SnapshotPayload,
  type WelcomePayload,
  newPlayerState,
  stepPlayer,
} from '@gridforce/shared';

import { RemotePlayerInterpolator } from './RemotePlayerInterpolator.js';

export interface PredictionDiagnostics {
  predictedTick: number;
  serverTick: number;
  pendingInputs: number;
  lastReplayInputs: number;
  lastPredictionErrorPx: number;
  /** Rolling max prediction error over the last ~3s. Lets the HUD show
   *  worst-case divergence instead of just the latest sample. */
  recentMaxErrorPx: number;
  /** Magnitude of the visual correction currently being blended out. If this
   *  is consistently nonzero during normal play, reconciliation is firing
   *  every snapshot and the player is being visibly pulled around. */
  correctionMagnitudePx: number;
  /** EWMA of |correction| sampled each frame. Catches sustained correction
   *  even if it's small per-frame. */
  correctionEwmaPx: number;
  smoothCorrections: number;
  hardSnaps: number;
  lastSnapAtTick: number;
}

export class PredictedWorld {
  grid: GridDef = { cols: 1, rows: 1, panelSize: 1 };
  localPlayerId: PlayerId = -1;

  // The player states we've simulated forward to predictedTick. For remote
  // players these get overwritten each snapshot; we don't predict them here
  // because the interpolator already does the job better.
  players = new Map<PlayerId, PlayerState>();
  // Snapshot of `players` from the previous predicted tick. Used by the
  // renderer to interpolate visually between two predicted states.
  prevPlayers = new Map<PlayerId, PlayerState>();

  serverTick = 0;
  predictedTick = 0;

  // Inputs we've shipped that the server hasn't acknowledged yet. Strictly
  // increasing in `tick`. Replayed on top of every snapshot to keep the local
  // player's predicted state consistent with what we'll see next.
  private pending: PlayerInput[] = [];

  // Visual-only position offset that blends to zero over PREDICTION_BLEND_MS.
  // The simulated position is updated immediately; only the rendered position
  // smoothly catches up.
  private correctionX = 0;
  private correctionY = 0;

  readonly remoteInterp = new RemotePlayerInterpolator();
  readonly diagnostics: PredictionDiagnostics = {
    predictedTick: 0,
    serverTick: 0,
    pendingInputs: 0,
    lastReplayInputs: 0,
    lastPredictionErrorPx: 0,
    recentMaxErrorPx: 0,
    correctionMagnitudePx: 0,
    correctionEwmaPx: 0,
    smoothCorrections: 0,
    hardSnaps: 0,
    lastSnapAtTick: -1,
  };
  // Rolling-window max for recentMaxErrorPx; decays to current sample over
  // ~3s of frames so spikes are visible briefly then fade.
  private maxErrorDecayK = 0.005;

  initFromWelcome(w: WelcomePayload): void {
    this.grid = w.grid;
    this.localPlayerId = w.yourPlayerId;
    // Lead the server tick from the start: by the time our first input
    // reaches the server, the server has already advanced past startTick by
    // ~RTT/2 ticks. Tagging from (startTick + LEAD) ensures the input lands
    // in the future relative to wherever the server is by then.
    this.predictedTick = w.startTick + INPUT_LEAD_TICKS;
    this.serverTick = w.startTick;
    this.players.clear();
    this.prevPlayers.clear();
    for (const p of w.players) {
      this.players.set(p.id, { ...p });
      this.prevPlayers.set(p.id, { ...p });
      if (p.id !== this.localPlayerId) this.remoteInterp.seed(p, w.serverTimeMs);
    }
  }

  ensurePlayer(state: PlayerState): void {
    if (!this.players.has(state.id)) {
      this.players.set(state.id, { ...state });
      this.prevPlayers.set(state.id, { ...state });
      if (state.id !== this.localPlayerId) {
        this.remoteInterp.seed(state, performance.now());
      }
    }
  }

  removePlayer(id: PlayerId): void {
    this.players.delete(id);
    this.prevPlayers.delete(id);
    this.remoteInterp.remove(id);
  }

  // Advance one predicted tick using the supplied input for the local player.
  // Returns the input tagged with its predicted tick (for sending to the server).
  step(local: { mx: number; my: number; dash: boolean; clientTimeMs: number }): PlayerInput {
    this.predictedTick++;

    // Snapshot prev for render-time interpolation.
    for (const [id, s] of this.players) this.prevPlayers.set(id, s);

    // Step local player.
    const localState =
      this.players.get(this.localPlayerId) ?? newPlayerState(this.localPlayerId, 0, 0);
    const input: PlayerInput = {
      tick: this.predictedTick,
      clientTimeMs: local.clientTimeMs,
      mx: local.mx,
      my: local.my,
      dash: local.dash,
    };
    const nextLocal = stepPlayer(localState, input, SERVER_TICK_DT_S, this.grid);
    this.players.set(this.localPlayerId, nextLocal);

    this.pending.push(input);
    // Cap pending list to bound replay cost on very bad networks.
    if (this.pending.length > MAX_REPLAY_INPUTS) this.pending.shift();

    this.diagnostics.predictedTick = this.predictedTick;
    this.diagnostics.pendingInputs = this.pending.length;

    return input;
  }

  applySnapshot(snap: SnapshotPayload): void {
    if (snap.tick < this.serverTick) return; // stale (out of order)
    this.serverTick = snap.tick;
    this.diagnostics.serverTick = snap.tick;

    // Safety: if our predicted tick has crept down close to (or below) the
    // server's current tick, our next input will arrive labeled with a tick
    // the server has already moved past — it'll be dropped as stale, and
    // the local player will appear "tethered" to their last good position
    // while smooth-correction snaps them back. Detect this and jump
    // predictedTick forward to the ideal lead, dropping pending inputs
    // whose tags are now stale. Only fires when we've actually fallen into
    // the drop zone (lead < 2 ticks); in steady state we sit at LEAD ticks
    // ahead and this branch never runs.
    const MIN_SAFE_LEAD = 2;
    if (this.predictedTick < snap.tick + MIN_SAFE_LEAD) {
      this.predictedTick = snap.tick + INPUT_LEAD_TICKS;
      this.pending = [];
    }

    // Drop pending inputs that have been processed server-side.
    while (this.pending.length > 0 && this.pending[0]!.tick <= snap.ackInputTick) {
      this.pending.shift();
    }

    // Update remote players via the interpolator. We never run prediction for
    // remotes; the interpolator buffers ~one snapshot interval and renders
    // between two known good snapshots.
    for (const p of snap.players) {
      if (p.id === this.localPlayerId) continue;
      this.remoteInterp.ingest(p, snap.serverTimeMs);
      // Also keep an authoritative copy in `players` (used by anything that
      // wants the latest known state, e.g., labels). Visual position comes
      // from remoteInterp.sample().
      this.players.set(p.id, { ...p });
    }

    // Reconcile local player.
    const localSnap = snap.players.find((p) => p.id === this.localPlayerId);
    if (!localSnap) {
      // We don't appear in the snapshot — wait for next one.
      this.diagnostics.pendingInputs = this.pending.length;
      return;
    }

    const before = this.players.get(this.localPlayerId);
    const beforeX = before?.x ?? localSnap.x;
    const beforeY = before?.y ?? localSnap.y;

    // Rebase: take server's view of us, then replay any unacked inputs.
    let rebased: PlayerState = { ...localSnap };
    for (const inp of this.pending) {
      rebased = stepPlayer(rebased, inp, SERVER_TICK_DT_S, this.grid);
    }
    this.diagnostics.lastReplayInputs = this.pending.length;

    const dx = beforeX - rebased.x;
    const dy = beforeY - rebased.y;
    const err = Math.hypot(dx, dy);
    this.diagnostics.lastPredictionErrorPx = err;

    if (err < PREDICTION_THRESHOLD_PX) {
      // Below the visible threshold; commit silently.
    } else if (err < PREDICTION_HARD_SNAP_PX) {
      // Smooth correction: visual stays where it was, simulated jumps; the
      // visible offset (correctionX/Y) bleeds to zero over PREDICTION_BLEND_MS.
      this.correctionX += dx;
      this.correctionY += dy;
      this.diagnostics.smoothCorrections++;
      this.diagnostics.lastSnapAtTick = snap.tick;
    } else {
      // Hard snap — likely a real bug or extreme packet loss. Log it.
      this.correctionX = 0;
      this.correctionY = 0;
      this.diagnostics.hardSnaps++;
      this.diagnostics.lastSnapAtTick = snap.tick;
      console.warn(`[reconcile] hard snap ${err.toFixed(1)}px at tick ${snap.tick}`);
    }

    if (err > this.diagnostics.recentMaxErrorPx) this.diagnostics.recentMaxErrorPx = err;

    this.players.set(this.localPlayerId, rebased);
    // Also reset prev for local so the next render frame interpolates from
    // the new authoritative position rather than an old predicted one. The
    // visible smoothing is now driven entirely by correctionX/Y.
    this.prevPlayers.set(this.localPlayerId, rebased);

    this.diagnostics.pendingInputs = this.pending.length;
  }

  // Each render frame, decay the visual correction toward zero.
  decayCorrection(dtMs: number): void {
    if (this.correctionX !== 0 || this.correctionY !== 0) {
      const k = Math.min(1, dtMs / PREDICTION_BLEND_MS);
      this.correctionX *= 1 - k;
      this.correctionY *= 1 - k;
      if (Math.abs(this.correctionX) < 0.05 && Math.abs(this.correctionY) < 0.05) {
        this.correctionX = 0;
        this.correctionY = 0;
      }
    }
    const mag = Math.hypot(this.correctionX, this.correctionY);
    this.diagnostics.correctionMagnitudePx = mag;
    // EWMA over ~0.5s at 60fps so the HUD shows sustained pull-back even when
    // each frame's correction is small.
    const alpha = Math.min(1, dtMs / 500);
    this.diagnostics.correctionEwmaPx =
      this.diagnostics.correctionEwmaPx * (1 - alpha) + mag * alpha;
    // Slow decay of recentMaxErrorPx so a spike fades in a few seconds.
    this.diagnostics.recentMaxErrorPx *= 1 - this.maxErrorDecayK;
  }

  // Visual position of the local player given an interpolation alpha
  // between prev and curr predicted states (0..1).
  visualLocalPosition(alpha: number): { x: number; y: number; facing: number } {
    const cur = this.players.get(this.localPlayerId);
    if (!cur) return { x: 0, y: 0, facing: 0 };
    const prev = this.prevPlayers.get(this.localPlayerId) ?? cur;
    const x = prev.x + (cur.x - prev.x) * alpha + this.correctionX;
    const y = prev.y + (cur.y - prev.y) * alpha + this.correctionY;
    // Facing interpolation must take the short way around the circle.
    const facing = lerpAngle(prev.facing, cur.facing, alpha);
    return { x, y, facing };
  }

  // For diagnostics / external readers.
  get correction(): { x: number; y: number } {
    return { x: this.correctionX, y: this.correctionY };
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + diff * t;
}
