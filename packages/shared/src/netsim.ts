// Pluggable transport simulator. Wraps any "real" send with configurable
// one-way latency / jitter / loss. Used both by the dev client (toggle from
// the debug HUD) and by the headless integration tests (apply the matrix).
//
// Two modes:
//   - 'udp' (default): packet-independent. Drops are real; each packet is
//     delayed by its own `owDelayMs ± jitterMs`. Models WebRTC DataChannel
//     with maxRetransmits=0.
//   - 'tcp-hol': stream-serialized. A "lost" packet is held back by
//     ~RTT to model retransmit, and subsequent packets queue behind it
//     (head-of-line blocking). Models a WebSocket / TCP path under loss.
//
// Apply once to outgoing and once to incoming for symmetric RTT = 2 × owDelayMs.

export type NetSimMode = 'udp' | 'tcp-hol';

export interface NetSimProfile {
  /** One-way delay in milliseconds. Round-trip time is 2 × owDelayMs. */
  owDelayMs: number;
  /** ± jitter applied to each one-way delay (uniform random). */
  jitterMs: number;
  /** Packet loss percentage, 0..100. */
  lossPct: number;
}

export const NETSIM_PROFILES: Record<string, NetSimProfile> = {
  off: { owDelayMs: 0, jitterMs: 0, lossPct: 0 },
  lan: { owDelayMs: 5, jitterMs: 1, lossPct: 0 },
  good: { owDelayMs: 25, jitterMs: 5, lossPct: 0 },
  fair: { owDelayMs: 50, jitterMs: 10, lossPct: 2 },
  poor: { owDelayMs: 75, jitterMs: 30, lossPct: 5 },
  bad: { owDelayMs: 150, jitterMs: 60, lossPct: 10 },
};

export class NetSim {
  private nextReadyAt = 0;

  constructor(
    public profile: NetSimProfile,
    private readonly mode: NetSimMode = 'udp',
    private readonly rng: () => number = Math.random,
    private readonly schedule: (cb: () => void, ms: number) => void = (cb, ms) =>
      void setTimeout(cb, ms),
    private readonly now: () => number = () =>
      typeof performance !== 'undefined' ? performance.now() : Date.now(),
  ) {}

  setProfile(p: NetSimProfile): void {
    this.profile = p;
  }

  passThrough(bytes: Uint8Array, deliver: (b: Uint8Array) => void): void {
    if (this.mode === 'udp') {
      if (this.profile.lossPct > 0 && this.rng() * 100 < this.profile.lossPct) return;
      const j = (this.rng() * 2 - 1) * this.profile.jitterMs;
      const delay = Math.max(0, this.profile.owDelayMs + j);
      if (delay <= 0) {
        deliver(bytes);
        return;
      }
      this.schedule(() => deliver(bytes), delay);
      return;
    }
    // tcp-hol: serialize through a single virtual stream. Subsequent
    // packets cannot be delivered before earlier ones, modeling TCP's
    // ordered-byte-stream guarantee. Simulated drops cost ~RTT and stall
    // everything behind them.
    const now = this.now();
    const j = (this.rng() * 2 - 1) * this.profile.jitterMs;
    const baseArrival = now + Math.max(0, this.profile.owDelayMs + j);
    let delivery = Math.max(baseArrival, this.nextReadyAt);
    if (this.profile.lossPct > 0 && this.rng() * 100 < this.profile.lossPct) {
      // Retransmit takes one RTT to detect-and-resend in steady state.
      delivery += this.profile.owDelayMs * 2;
    }
    this.nextReadyAt = delivery;
    const ms = Math.max(0, delivery - now);
    if (ms <= 0) {
      deliver(bytes);
      return;
    }
    this.schedule(() => deliver(bytes), ms);
  }

  // Convenience: returns a wrapped sender.
  wrap(realSend: (b: Uint8Array) => void): (b: Uint8Array) => void {
    return (b) => this.passThrough(b, realSend);
  }
}
