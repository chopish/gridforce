import {
  REMOTE_INTERP_DEAD_RECKON_MAX_MS,
  REMOTE_INTERP_DELAY_MAX_MS,
  REMOTE_INTERP_DELAY_MIN_MS,
  REMOTE_INTERP_DELAY_SEED_MS,
  type PlayerId,
  type PlayerState,
} from '@gridforce/shared';

interface BufferedSnapshot {
  arrivalAt: number; // performance.now()
  state: PlayerState;
}

const MAX_BUFFER_LEN = 30;
const ARRIVAL_HISTORY = 60;

// Adaptive interpolation buffer for remote players.
//
// Goal: render remote players at (now - delay) so we always have a snapshot
// in front of and behind that point to interpolate between. Delay is sized to
// the observed inter-arrival jitter so it tracks bad networks without being
// gratuitously laggy on good ones.
//
// On underflow (no recent snapshot — packet loss or stall) we dead-reckon
// using the velocity inferred from the last two snapshots, capped at
// REMOTE_INTERP_DEAD_RECKON_MAX_MS. After that we freeze to avoid drifting
// off into nonsense.
//
// On tab-visibility-restore we discard accumulated buffer history except the
// most recent snapshot — replaying the missed seconds would look terrible.
export class RemotePlayerInterpolator {
  private buffers = new Map<PlayerId, BufferedSnapshot[]>();
  private arrivalIntervals: number[] = [];
  private lastArrivalAt = 0;
  private delayMs = REMOTE_INTERP_DELAY_SEED_MS;

  get currentDelayMs(): number {
    return this.delayMs;
  }

  seed(state: PlayerState, _serverTimeMs: number): void {
    const now = performance.now();
    this.buffers.set(state.id, [{ arrivalAt: now, state: { ...state } }]);
  }

  ingest(state: PlayerState, _serverTimeMs: number): void {
    const now = performance.now();
    if (this.lastArrivalAt > 0) {
      const dt = now - this.lastArrivalAt;
      this.arrivalIntervals.push(dt);
      if (this.arrivalIntervals.length > ARRIVAL_HISTORY) this.arrivalIntervals.shift();
      this.recomputeDelay();
    }
    this.lastArrivalAt = now;

    let buf = this.buffers.get(state.id);
    if (!buf) {
      buf = [];
      this.buffers.set(state.id, buf);
    }
    buf.push({ arrivalAt: now, state: { ...state } });
    if (buf.length > MAX_BUFFER_LEN) buf.shift();
  }

  remove(id: PlayerId): void {
    this.buffers.delete(id);
  }

  // Returns the visual position for `id` at `renderNow` (performance.now()),
  // or null if we have nothing to draw.
  sample(id: PlayerId, renderNow: number): { x: number; y: number; facing: number } | null {
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) return null;
    const renderTime = renderNow - this.delayMs;

    // Find brackets — last snapshot at or before renderTime, first at or after.
    let prev: BufferedSnapshot | null = null;
    let next: BufferedSnapshot | null = null;
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i]!;
      if (s.arrivalAt <= renderTime) prev = s;
      if (s.arrivalAt >= renderTime) {
        next = s;
        if (prev && next !== prev) break;
        // If next is the same as prev (exact equality), keep looking.
      }
    }

    if (prev && next && prev !== next) {
      const span = next.arrivalAt - prev.arrivalAt;
      const t = span > 0 ? (renderTime - prev.arrivalAt) / span : 0;
      return {
        x: prev.state.x + (next.state.x - prev.state.x) * t,
        y: prev.state.y + (next.state.y - prev.state.y) * t,
        facing: lerpAngle(prev.state.facing, next.state.facing, t),
      };
    }

    // No future bracket — underflow. Dead-reckon from last known.
    const last = buf[buf.length - 1]!;
    if (buf.length >= 2 && renderTime > last.arrivalAt) {
      const prev2 = buf[buf.length - 2]!;
      const dt = (last.arrivalAt - prev2.arrivalAt) / 1000;
      if (dt > 0) {
        const vx = (last.state.x - prev2.state.x) / dt;
        const vy = (last.state.y - prev2.state.y) / dt;
        const tFwd = (renderTime - last.arrivalAt) / 1000;
        if (tFwd * 1000 <= REMOTE_INTERP_DEAD_RECKON_MAX_MS) {
          return {
            x: last.state.x + vx * tFwd,
            y: last.state.y + vy * tFwd,
            facing: last.state.facing,
          };
        }
      }
    }

    // Frozen: hold last known position.
    return { x: last.state.x, y: last.state.y, facing: last.state.facing };
  }

  // Discard buffer history (called on tab-visibility-restore to avoid
  // replaying the gap as a catch-up animation).
  resetForVisibilityRestore(): void {
    for (const [id, buf] of this.buffers) {
      if (buf.length > 1) this.buffers.set(id, [buf[buf.length - 1]!]);
    }
    this.lastArrivalAt = 0;
    this.arrivalIntervals = [];
    this.delayMs = REMOTE_INTERP_DELAY_SEED_MS;
  }

  private recomputeDelay(): void {
    if (this.arrivalIntervals.length < 5) return;
    const sorted = [...this.arrivalIntervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    const jitter = Math.max(0, p95 - median);
    // Aim to render one snapshot interval behind plus 2× observed jitter.
    let target = median + jitter * 2;
    if (target < REMOTE_INTERP_DELAY_MIN_MS) target = REMOTE_INTERP_DELAY_MIN_MS;
    if (target > REMOTE_INTERP_DELAY_MAX_MS) target = REMOTE_INTERP_DELAY_MAX_MS;
    this.delayMs = this.delayMs * 0.9 + target * 0.1;
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + diff * t;
}
