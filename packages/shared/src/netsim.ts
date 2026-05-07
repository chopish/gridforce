// Pluggable transport simulator. Wraps any "real" send with configurable
// one-way latency / jitter / loss. Used both by the dev client (toggle from
// the debug HUD) and by the headless integration tests (apply the matrix).
//
// Usage:
//   const sim = new NetSim({ owDelayMs: 50, jitterMs: 10, lossPct: 2 });
//   const sendThroughSim = sim.wrap(realSend);
//   sendThroughSim(bytes); // may drop, will be delayed
//
// Apply once to outgoing and once to incoming for symmetric RTT = 2 × owDelayMs.

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
  constructor(
    public profile: NetSimProfile,
    private readonly rng: () => number = Math.random,
    private readonly schedule: (cb: () => void, ms: number) => void = (cb, ms) =>
      void setTimeout(cb, ms),
  ) {}

  setProfile(p: NetSimProfile): void {
    this.profile = p;
  }

  // Decide drop, then delay and dispatch.
  passThrough(bytes: Uint8Array, deliver: (b: Uint8Array) => void): void {
    if (this.profile.lossPct > 0 && this.rng() * 100 < this.profile.lossPct) return;
    const j = (this.rng() * 2 - 1) * this.profile.jitterMs;
    const delay = Math.max(0, this.profile.owDelayMs + j);
    if (delay <= 0) {
      deliver(bytes);
      return;
    }
    this.schedule(() => deliver(bytes), delay);
  }

  // Convenience: returns a wrapped sender.
  wrap(realSend: (b: Uint8Array) => void): (b: Uint8Array) => void {
    return (b) => this.passThrough(b, realSend);
  }
}
