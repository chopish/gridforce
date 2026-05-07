// Deterministic 32-bit RNG (mulberry32). Seed in, seed out — no hidden state.
// We pass the rngState through WorldState so replays are reproducible.

export function nextRng(state: number): { state: number; value: number } {
  let s = (state + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: s, value };
}

export function rngRange(state: number, min: number, max: number): { state: number; value: number } {
  const r = nextRng(state);
  return { state: r.state, value: min + r.value * (max - min) };
}
