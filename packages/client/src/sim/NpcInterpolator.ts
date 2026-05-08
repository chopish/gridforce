import {
  REMOTE_INTERP_DELAY_MAX_MS,
  REMOTE_INTERP_DELAY_MIN_MS,
  REMOTE_INTERP_DELAY_SEED_MS,
  type NpcState,
} from '@gridforce/shared';

// Buffer-and-delay interpolator for NPCs, parallel in spirit to
// RemotePlayerInterpolator but operating over the whole NPC group at once.
// We render NPCs at (now - delayMs) so a dropped or jittery snapshot
// doesn't show up as a stutter — by the time we'd be rendering against
// the missing snapshot, the next one has usually arrived. Delay tracks
// observed inter-arrival jitter so it stays small on lan/good and grows
// to absorb reality on poor/bad.
//
// We hold a small ring buffer of full snapshots. Per-NPC state is shared
// by reference inside the buffer entries — we never deep-copy the NpcState
// objects, so memory is roughly (BUFFER_LEN × npcCount × ~40 bytes / map
// entry) which at 1024 NPCs and 8 entries is ~330 KB per client.

interface NpcSnapshotEntry {
  arrivalAt: number; // performance.now()
  npcs: Map<number, NpcState>;
}

const BUFFER_LEN = 8;
const ARRIVAL_HISTORY = 60;
const DEAD_RECKON_MAX_MS = 200;

export class NpcInterpolator {
  private buffer: NpcSnapshotEntry[] = [];
  private arrivalIntervals: number[] = [];
  private lastArrivalAt = 0;
  private delayMs = REMOTE_INTERP_DELAY_SEED_MS;

  get currentDelayMs(): number {
    return this.delayMs;
  }

  ingest(npcs: NpcState[]): void {
    const now = performance.now();
    if (this.lastArrivalAt > 0) {
      const dt = now - this.lastArrivalAt;
      this.arrivalIntervals.push(dt);
      if (this.arrivalIntervals.length > ARRIVAL_HISTORY) this.arrivalIntervals.shift();
      this.recomputeDelay();
    }
    this.lastArrivalAt = now;

    if (npcs.length === 0) {
      // Empty snapshot: don't push an entry — the buffer is already
      // empty-equivalent for this tick, and skipping keeps the timing
      // history meaningful.
      this.buffer.push({ arrivalAt: now, npcs: new Map() });
    } else {
      const map = new Map<number, NpcState>();
      for (const n of npcs) map.set(n.id, n);
      this.buffer.push({ arrivalAt: now, npcs: map });
    }
    if (this.buffer.length > BUFFER_LEN) this.buffer.shift();
  }

  // Iterate render states for the moment (renderNow - delayMs). The
  // callback receives interpolated x/y/facing for each NPC currently
  // visible. Allocation-free in the hot path: no per-frame array
  // construction.
  forEachRender(
    renderNow: number,
    fn: (id: number, x: number, y: number, facing: number) => void,
  ): void {
    if (this.buffer.length === 0) return;
    const renderTime = renderNow - this.delayMs;

    let prev: NpcSnapshotEntry | null = null;
    let next: NpcSnapshotEntry | null = null;
    for (let i = 0; i < this.buffer.length; i++) {
      const e = this.buffer[i]!;
      if (e.arrivalAt <= renderTime) prev = e;
      if (e.arrivalAt >= renderTime) {
        next = e;
        if (prev && next !== prev) break;
      }
    }

    if (prev && next && prev !== next) {
      const span = next.arrivalAt - prev.arrivalAt;
      const t = span > 0 ? (renderTime - prev.arrivalAt) / span : 0;
      // Iterate the union of ids across both — newcomers first appear in
      // `next`; despawned NPCs are still in `prev` but not `next`. We
      // emit only ids in `next` so disappeared NPCs don't ghost.
      for (const [id, nN] of next.npcs) {
        const pN = prev.npcs.get(id) ?? nN;
        const x = pN.x + (nN.x - pN.x) * t;
        const y = pN.y + (nN.y - pN.y) * t;
        const facing = lerpAngle(pN.facing, nN.facing, t);
        fn(id, x, y, facing);
      }
      return;
    }

    // Underflow: render past the most recent snapshot. Brief dead-reckon
    // using the velocity inferred from the last two known snapshots, then
    // freeze. With 8 buffer slots this only kicks in after a multi-snap
    // stall, which is exactly the case where TCP retransmit + jitter
    // would otherwise produce a visible jump on the next arrival.
    const last = this.buffer[this.buffer.length - 1]!;
    const prev2 = this.buffer.length >= 2 ? this.buffer[this.buffer.length - 2]! : null;
    if (prev2 && renderTime > last.arrivalAt) {
      const dt = (last.arrivalAt - prev2.arrivalAt) / 1000;
      const tFwdMs = renderTime - last.arrivalAt;
      if (dt > 0 && tFwdMs <= DEAD_RECKON_MAX_MS) {
        const tFwdS = tFwdMs / 1000;
        for (const [id, lastN] of last.npcs) {
          const prevN = prev2.npcs.get(id);
          if (prevN) {
            const vx = (lastN.x - prevN.x) / dt;
            const vy = (lastN.y - prevN.y) / dt;
            fn(id, lastN.x + vx * tFwdS, lastN.y + vy * tFwdS, lastN.facing);
          } else {
            fn(id, lastN.x, lastN.y, lastN.facing);
          }
        }
        return;
      }
    }

    for (const [id, n] of last.npcs) fn(id, n.x, n.y, n.facing);
  }

  resetForVisibilityRestore(): void {
    if (this.buffer.length > 1) {
      this.buffer = [this.buffer[this.buffer.length - 1]!];
    }
    this.arrivalIntervals = [];
    this.lastArrivalAt = 0;
    this.delayMs = REMOTE_INTERP_DELAY_SEED_MS;
  }

  get count(): number {
    if (this.buffer.length === 0) return 0;
    return this.buffer[this.buffer.length - 1]!.npcs.size;
  }

  private recomputeDelay(): void {
    if (this.arrivalIntervals.length < 5) return;
    const sorted = [...this.arrivalIntervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    const jitter = Math.max(0, p95 - median);
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
