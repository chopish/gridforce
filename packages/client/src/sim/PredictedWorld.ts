import {
  PREDICTION_ERROR_THRESHOLD,
  TICK_DT_S,
  simulate,
  type Grid,
  type Player,
  type PlayerInput,
  type ServerSnapshot,
  type WorldState,
} from '@gridforce/shared';

interface SnapshotRecord {
  receivedAt: number; // performance.now() at receive
  serverTime: number;
  tick: number;
  players: Player[];
}

// Owns the local predicted world state for the local player.
// Other players are not predicted; their rendered position comes from
// snapshot interpolation (see RemotePlayerInterpolator below).
export class PredictedWorld {
  readonly localPlayerId: string;
  // Sim state from the previous tick. Together with `state`, lets the renderer
  // do prev/current interpolation so on-screen motion is smooth and never
  // overshoots the sim — no more direction-reversal teleports.
  prevState: WorldState;
  state: WorldState;
  currentTick: number;
  private pendingInputs: PlayerInput[] = [];
  private latestAckInputTick = -1;
  private latestSnapshotTick = -1;

  // Diagnostic counters
  lastReconcileRewindTicks = 0;
  lastPredictionErrorPx = 0;

  constructor(localPlayerId: string, grid: Grid, initialSnapshot: ServerSnapshot) {
    this.localPlayerId = localPlayerId;
    this.state = {
      tick: initialSnapshot.tick,
      grid,
      players: initialSnapshot.players,
      rngState: 0,
    };
    this.prevState = this.state;
    this.currentTick = initialSnapshot.tick;
  }

  // Step prediction forward by one tick using the local player's input.
  // Returns the input we just applied (caller forwards it to the server).
  step(localInput: Omit<PlayerInput, 'tick'>): PlayerInput {
    this.currentTick += 1;
    const input: PlayerInput = { tick: this.currentTick, ...localInput };
    this.pendingInputs.push(input);

    const m = new Map<string, PlayerInput>();
    m.set(this.localPlayerId, input);
    this.prevState = this.state;
    this.state = simulate(this.state, m, TICK_DT_S);

    // Bound pendingInputs (~10 sec at 60 Hz = 600)
    if (this.pendingInputs.length > 600) {
      this.pendingInputs.splice(0, this.pendingInputs.length - 600);
    }

    return input;
  }

  // Render-time interpolation between prevState and state for the local
  // player. alpha in [0,1]: 0 = prev, 1 = current. Other fields (vx, dashTimer,
  // facing) are taken from current — only x/y are tweened.
  getInterpolatedLocalPlayer(alpha: number): Player | undefined {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const curr = this.state.players.find((p) => p.id === this.localPlayerId);
    if (!curr) return undefined;
    const prev = this.prevState.players.find((p) => p.id === this.localPlayerId);
    if (!prev) return curr;
    return {
      ...curr,
      x: prev.x + (curr.x - prev.x) * a,
      y: prev.y + (curr.y - prev.y) * a,
    };
  }

  // Apply a server snapshot. Reconciles local prediction against authoritative state.
  applySnapshot(snap: ServerSnapshot): void {
    if (snap.tick < this.latestSnapshotTick) return; // stale
    this.latestSnapshotTick = snap.tick;
    this.latestAckInputTick = snap.ackInputTick;

    // Drop acknowledged inputs
    this.pendingInputs = this.pendingInputs.filter((i) => i.tick > snap.ackInputTick);

    const localFromSnap = snap.players.find((p) => p.id === this.localPlayerId);
    if (!localFromSnap) {
      // We're not in the snapshot (just-joined edge case). Trust snapshot wholesale.
      this.state = { ...this.state, tick: snap.tick, players: snap.players };
      return;
    }

    // Rebase from server snapshot, then replay every still-pending input.
    // ackInputTick already excluded the inputs the server has applied, so every
    // remaining pending input is unaccounted for in the snapshot and must be
    // re-applied to bring the local prediction up to currentTick.
    let rebased: WorldState = {
      tick: snap.tick,
      grid: this.state.grid,
      players: snap.players,
      rngState: this.state.rngState,
    };

    const replayInputs = this.pendingInputs;
    this.lastReconcileRewindTicks = replayInputs.length;
    for (const inp of replayInputs) {
      const m = new Map<string, PlayerInput>();
      m.set(this.localPlayerId, inp);
      rebased = simulate(rebased, m, TICK_DT_S);
    }

    // Compare: if the rebased local player differs from current predicted local, snap to rebased
    const predictedLocal = this.state.players.find((p) => p.id === this.localPlayerId);
    const rebasedLocal = rebased.players.find((p) => p.id === this.localPlayerId);
    if (predictedLocal && rebasedLocal) {
      const dx = rebasedLocal.x - predictedLocal.x;
      const dy = rebasedLocal.y - predictedLocal.y;
      this.lastPredictionErrorPx = Math.hypot(dx, dy);

      if (this.lastPredictionErrorPx > PREDICTION_ERROR_THRESHOLD) {
        // Replace local player state with rebased; keep snapshot-fresh data for others.
        this.state = {
          ...this.state,
          tick: this.currentTick,
          players: this.state.players.map((p) =>
            p.id === this.localPlayerId ? rebasedLocal : p,
          ),
        };
      }
    }

    // Always update non-local player state from the snapshot (their authoritative
    // positions should drive interpolation; predicted state shouldn't drift).
    const snapById = new Map(snap.players.map((p) => [p.id, p]));
    this.state = {
      ...this.state,
      players: this.state.players.map((p) => {
        if (p.id === this.localPlayerId) return p;
        return snapById.get(p.id) ?? p;
      }),
    };

    // Add or remove players that joined/left
    const knownIds = new Set(this.state.players.map((p) => p.id));
    for (const p of snap.players) {
      if (!knownIds.has(p.id)) {
        this.state = { ...this.state, players: [...this.state.players, p] };
      }
    }
    const snapIds = new Set(snap.players.map((p) => p.id));
    if (this.state.players.some((p) => !snapIds.has(p.id))) {
      this.state = { ...this.state, players: this.state.players.filter((p) => snapIds.has(p.id)) };
    }
  }

  getLocalPlayer(): Player | undefined {
    return this.state.players.find((p) => p.id === this.localPlayerId);
  }

  pendingInputCount(): number {
    return this.pendingInputs.length;
  }
}

// Buffers recent snapshots and produces interpolated remote-player positions.
export class RemotePlayerInterpolator {
  private snapshots: SnapshotRecord[] = [];
  private interpolationDelayMs: number;

  constructor(interpolationDelayMs: number) {
    this.interpolationDelayMs = interpolationDelayMs;
  }

  push(snap: ServerSnapshot): void {
    const now = performance.now();
    this.snapshots.push({
      receivedAt: now,
      serverTime: snap.serverTime,
      tick: snap.tick,
      players: snap.players,
    });
    // Drop anything older than the interpolation window plus a small safety
    // margin. Without this, a hidden tab accumulates a long history of
    // snapshots that replay at normal speed when the tab returns — the
    // dreaded "catch-up" where remote players walk through five seconds
    // of past motion in five seconds of real time.
    const ageCutoff = now - (this.interpolationDelayMs + 200);
    while (this.snapshots.length > 0 && this.snapshots[0]!.receivedAt < ageCutoff) {
      this.snapshots.shift();
    }
    // Hard cap to bound memory in case clocks misbehave.
    if (this.snapshots.length > 90) this.snapshots.shift();
  }

  // Drop everything except the most recent snapshot. Call this when the tab
  // returns — the buffer may be full of recent snapshots received during the
  // hidden period; we want to render at the current authoritative position
  // immediately rather than walking backward through the history.
  reset(): void {
    if (this.snapshots.length > 1) {
      const latest = this.snapshots[this.snapshots.length - 1]!;
      this.snapshots = [latest];
    }
  }

  // Returns interpolated positions for all NON-local players at the current
  // render time. Local player is excluded — caller should render from PredictedWorld.
  interpolate(localPlayerId: string): Player[] {
    if (this.snapshots.length === 0) return [];
    const renderTime = performance.now() - this.interpolationDelayMs;

    // Find the two snapshots straddling renderTime
    let earlier: SnapshotRecord | undefined;
    let later: SnapshotRecord | undefined;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const s = this.snapshots[i]!;
      if (s.receivedAt <= renderTime) {
        earlier = s;
        later = this.snapshots[i + 1];
        break;
      }
    }
    if (!earlier) earlier = this.snapshots[0]!;
    if (!later) later = this.snapshots[this.snapshots.length - 1]!;

    if (earlier === later) {
      return earlier.players.filter((p) => p.id !== localPlayerId);
    }

    const span = later.receivedAt - earlier.receivedAt;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - earlier.receivedAt) / span)) : 0;

    const earlierById = new Map(earlier.players.map((p) => [p.id, p]));
    const laterById = new Map(later.players.map((p) => [p.id, p]));
    const ids = new Set<string>([...earlierById.keys(), ...laterById.keys()]);

    const out: Player[] = [];
    for (const id of ids) {
      if (id === localPlayerId) continue;
      const a = earlierById.get(id);
      const b = laterById.get(id);
      const base = b ?? a;
      if (!base) continue;
      if (a && b) {
        out.push({
          ...base,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
        });
      } else {
        out.push(base);
      }
    }
    return out;
  }
}
