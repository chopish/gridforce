import {
  INPUT_LEAD_TICKS,
  MAX_INPUT_LEAD_TICKS,
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
  // Mirrored from snapshot/Welcome. UI gates ready toggles + start button on
  // these. Defaults to 'lobby' so a stale-state glance during connect doesn't
  // show the playfield as live before we've actually heard from the server.
  phase: 'lobby' | 'playing' = 'lobby';
  hostId: PlayerId = 0xff;

  // The player states we've simulated forward to predictedTick. For remote
  // players these get overwritten each snapshot; we don't predict them here
  // because the interpolator already does the job better.
  players = new Map<PlayerId, PlayerState>();
  // Snapshot of `players` from the previous predicted tick. Used by the
  // renderer to interpolate visually between two predicted states.
  prevPlayers = new Map<PlayerId, PlayerState>();

  serverTick = 0;
  predictedTick = 0;

  // The "lead" — how many ticks ahead of the server we predict — is the
  // floor below which inputs we send arrive too late to be applied. Defaults
  // to INPUT_LEAD_TICKS but grows when measured RTT pushes that floor up.
  // main.ts updates this from the live RTT EWMA each frame.
  private targetLead = INPUT_LEAD_TICKS;
  setTargetLead(ticks: number): void {
    const floored = Math.max(INPUT_LEAD_TICKS, Math.floor(ticks));
    this.targetLead = Math.min(MAX_INPUT_LEAD_TICKS, floored);
  }
  get currentLead(): number {
    return this.targetLead;
  }

  // Called when the tab regains visibility. While backgrounded, rAF may have
  // still fired (Chrome typically throttles to 1 Hz, not zero), so the loop
  // ran with clamped dt and accumulated many predicted ticks; meanwhile the
  // RTT measurement spiked from delayed pongs and pushed targetLead toward
  // its cap. Result: predictedTick can be hundreds of ticks ahead of the
  // server, with a queue of inputs labeled with future ticks. The next
  // snapshot would treat that as a normal reconciliation and try to smooth-
  // correct an enormous error. Better to forcibly resync: reset prediction
  // to (latest known server tick + base lead), drop pending inputs (they're
  // tagged with stale future ticks the server can't usefully apply), and
  // wipe the visual correction so we don't blend through 12 seconds of
  // movement.
  forceResyncOnVisibilityRestore(): void {
    this.predictedTick = this.serverTick + INPUT_LEAD_TICKS;
    this.targetLead = INPUT_LEAD_TICKS;
    this.pending = [];
    this.correctionX = 0;
    this.correctionY = 0;
    this.diagnostics.predictedTick = this.predictedTick;
    this.diagnostics.pendingInputs = 0;
    this.diagnostics.correctionMagnitudePx = 0;
    this.diagnostics.correctionEwmaPx = 0;
    this.diagnostics.recentMaxErrorPx = 0;
    this.diagnostics.smoothCorrections = 0;
    this.diagnostics.hardSnaps = 0;
    this.diagnostics.lastReplayInputs = 0;
  }

  // Last-rendered visual position + the alpha used. Lets applySnapshot
  // compute a correction that preserves on-screen position exactly, so
  // there's no visible discontinuity when a snapshot arrives mid-tick.
  private lastRenderAlpha = 0;
  private lastVisualX = 0;
  private lastVisualY = 0;

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
    this.phase = w.phase;
    this.hostId = w.hostId;
    // Lead the server tick from the start: by the time our first input
    // reaches the server, the server has already advanced past startTick by
    // ~RTT/2 ticks. Tagging from (startTick + lead) ensures the input lands
    // in the future relative to wherever the server is by then.
    this.predictedTick = w.startTick + this.targetLead;
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
    this.phase = snap.phase;
    this.hostId = snap.hostId;

    // Lead maintenance. Two regimes:
    //   1. predictedTick has fallen below MIN_SAFE_LEAD (or even past the
    //      server) — our next input will arrive tagged for a tick the
    //      server already processed, so it'll be dropped. Hard reset:
    //      jump predictedTick to (snap.tick + targetLead) and drop
    //      pending inputs whose tags are now stale.
    //   2. predictedTick is healthy but below targetLead — RTT measurement
    //      grew (e.g. user switched netsim to a worse profile or actual
    //      latency rose) and we need more lead. Skip a few ticks to push
    //      predictedTick up to targetLead. Don't drop pending: those
    //      inputs are still valid for their tagged ticks. The skipped
    //      ticks have no inputs sent — both server and client treat them
    //      as idle, so they remain in agreement.
    // Without (2), setTargetLead's adaptive bump only takes effect via the
    // recovery in (1), which only fires when lead drops near zero. Result
    // pre-fix: HUD `lead` would stick at INPUT_LEAD_TICKS regardless of
    // RTT, inputs would arrive late at server on bad profiles, and the
    // server would idle for those ticks → ~7 px/tick divergence → visible
    // sustained correction.
    const MIN_SAFE_LEAD = 2;
    if (this.predictedTick < snap.tick + MIN_SAFE_LEAD) {
      this.predictedTick = snap.tick + this.targetLead;
      this.pending = [];
    } else if (this.predictedTick < snap.tick + this.targetLead) {
      // Lead grew (RTT rose). Bump predictedTick up to targetLead. CRUCIAL:
      // advance the local player's stepPlayer state for the skipped ticks
      // with idle input so dashRemainingS / dashCooldownS / movement-state
      // stay consistent with the new predictedTick. Server treated these
      // ticks as idle (we never sent inputs for them) so client must too.
      // Without this, dash/cooldown timers freeze for the skip duration
      // and cause visible dash-state desync on each catch-up under jitter.
      const skip = snap.tick + this.targetLead - this.predictedTick;
      const localCur = this.players.get(this.localPlayerId);
      if (localCur) {
        let advanced = localCur;
        for (let i = 0; i < skip; i++) {
          advanced = stepPlayer(
            advanced,
            {
              tick: this.predictedTick + i + 1,
              clientTimeMs: 0,
              mx: 0,
              my: 0,
              dash: false,
            },
            SERVER_TICK_DT_S,
            this.grid,
          );
        }
        this.players.set(this.localPlayerId, advanced);
      }
      this.predictedTick = snap.tick + this.targetLead;
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

    // Update the simulated state to rebased. CRUCIAL: do NOT reset prev to
    // rebased here. If we did, the render-time lerp(prev, cur, alpha) would
    // return rebased for any alpha and the on-screen position would freeze
    // until the next step() runs (up to ~16ms of dropped-frame appearance,
    // visible as constant micro-stutter at the snapshot rate). Leaving prev
    // alone lets the lerp finish smoothly from where it was toward the
    // rebased target over the rest of this tick.
    const oldPrev = this.prevPlayers.get(this.localPlayerId);
    this.players.set(this.localPlayerId, rebased);

    // Visual continuity. When divergence is real (>= threshold), compute a
    // correction that keeps the on-screen position exactly where it just was
    // and let it bleed to zero over PREDICTION_BLEND_MS. Below threshold, do
    // nothing — the sub-threshold rebase shifts the visual by at most
    // (alpha * err) ≈ <3 px, which is imperceptible, and resetting the
    // correction every snapshot was preventing the existing correction from
    // ever decaying (sustained ~7 px pull at 20 Hz snapshot rate vs 150 ms
    // blend = correction can never reach below ~2/3 of its peak).
    if (oldPrev && err >= PREDICTION_THRESHOLD_PX && err < PREDICTION_HARD_SNAP_PX) {
      const expectedNextLerpX = oldPrev.x + this.lastRenderAlpha * (rebased.x - oldPrev.x);
      const expectedNextLerpY = oldPrev.y + this.lastRenderAlpha * (rebased.y - oldPrev.y);
      this.correctionX = this.lastVisualX - expectedNextLerpX;
      this.correctionY = this.lastVisualY - expectedNextLerpY;
      this.diagnostics.smoothCorrections++;
      this.diagnostics.lastSnapAtTick = snap.tick;
    } else if (err >= PREDICTION_HARD_SNAP_PX) {
      // Hard snap — wipe correction so visual moves to rebased immediately.
      this.correctionX = 0;
      this.correctionY = 0;
      this.diagnostics.hardSnaps++;
      this.diagnostics.lastSnapAtTick = snap.tick;
      console.warn(`[reconcile] hard snap ${err.toFixed(1)}px at tick ${snap.tick}`);
    }

    if (err > this.diagnostics.recentMaxErrorPx) this.diagnostics.recentMaxErrorPx = err;

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
  // between prev and curr predicted states (0..1). Caches alpha + result
  // so applySnapshot can compute a visually-continuous correction.
  visualLocalPosition(alpha: number): { x: number; y: number; facing: number } {
    this.lastRenderAlpha = alpha;
    const cur = this.players.get(this.localPlayerId);
    if (!cur) return { x: 0, y: 0, facing: 0 };
    const prev = this.prevPlayers.get(this.localPlayerId) ?? cur;
    const x = prev.x + (cur.x - prev.x) * alpha + this.correctionX;
    const y = prev.y + (cur.y - prev.y) * alpha + this.correctionY;
    this.lastVisualX = x;
    this.lastVisualY = y;
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
