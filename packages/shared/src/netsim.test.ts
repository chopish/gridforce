import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NetSim, type NetSimMode, type NetSimProfile } from './netsim.js';

// Test harness: a deterministic scheduler + RNG so we can assert
// timings and decisions exactly. Real NetSim uses setTimeout +
// Math.random; injecting both removes wall-clock and PRNG variance
// from the suite.
function makeHarness() {
  let clock = 0;
  const tasks: Array<{ at: number; cb: () => void }> = [];
  const schedule = (cb: () => void, ms: number) => {
    tasks.push({ at: clock + ms, cb });
  };
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
    // Drain in monotonic order so HOL serialization is honoured.
    tasks.sort((a, b) => a.at - b.at);
    while (tasks.length && tasks[0]!.at <= clock) tasks.shift()!.cb();
  };
  return { schedule, now, advance };
}

// Sequence RNG: each call yields the next value, looping. Lets a test
// say "drop the third packet" by feeding e.g. [0.5, 0.5, 0.0, 0.5, ...].
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i++;
    return v;
  };
}

function makeSim(
  mode: NetSimMode,
  profile: NetSimProfile,
  rngValues: number[],
): {
  sim: NetSim;
  delivered: Uint8Array[];
  send: (n: number) => void;
  advance: (ms: number) => void;
  now: () => number;
} {
  const h = makeHarness();
  const sim = new NetSim(profile, mode, seqRng(rngValues), h.schedule, h.now);
  const delivered: Uint8Array[] = [];
  const deliver = (b: Uint8Array) => {
    delivered.push(b);
  };
  return {
    sim,
    delivered,
    send: (n: number) => sim.passThrough(new Uint8Array([n]), deliver),
    advance: h.advance,
    now: h.now,
  };
}

// ---------------------------------------------------------------------------
// UDP mode
// ---------------------------------------------------------------------------

test('udp: zero delay + zero loss delivers synchronously', () => {
  const { sim, delivered } = makeSim('udp', { owDelayMs: 0, jitterMs: 0, lossPct: 0 }, [0.5]);
  sim.passThrough(new Uint8Array([1, 2, 3]), (b) => delivered.push(b));
  // Zero total delay → fast path skips the scheduler entirely.
  assert.equal(delivered.length, 1);
  assert.deepEqual(Array.from(delivered[0]!), [1, 2, 3]);
});

test('udp: 100% loss drops everything, even with no delay', () => {
  const { send, delivered } = makeSim(
    'udp',
    { owDelayMs: 0, jitterMs: 0, lossPct: 100 },
    // Any value < 100 triggers drop; 0.0 always does.
    [0],
  );
  for (let i = 0; i < 10; i++) send(i);
  assert.equal(delivered.length, 0);
});

test('udp: each packet is independently delayed (no HOL)', () => {
  // Three packets, no jitter (rng centred on 0.5 → jitter = 0), each
  // takes exactly owDelayMs. No loss (rng[1] = 0.99 keeps drop check above lossPct).
  // Pattern feeds [jitter, lossDecide] per packet.
  const { send, advance, delivered } = makeSim(
    'udp',
    { owDelayMs: 50, jitterMs: 0, lossPct: 1 },
    [0.5, 0.99],
  );
  send(1);
  send(2);
  send(3);
  // Nothing yet — they're scheduled.
  assert.equal(delivered.length, 0);
  advance(49);
  assert.equal(delivered.length, 0);
  advance(1); // total 50ms
  // All three fire at the same simulated time; UDP is independent.
  assert.equal(delivered.length, 3);
});

// ---------------------------------------------------------------------------
// TCP-HOL mode
// ---------------------------------------------------------------------------

test('tcp-hol: subsequent packets serialise behind earlier ones', () => {
  // owDelay = 50, no jitter, no loss. Three sends at t=0:
  // - p1: delivery = 0 + 50 = 50ms
  // - p2: delivery = max(0+50, 50) = 50ms — same? No: nextReadyAt is 50
  //   AFTER p1 was processed, so p2 sees nextReadyAt=50 and arrives at
  //   max(50, 50) = 50, then bumps nextReadyAt to 50.
  //   So in this no-loss case all three arrive together at 50ms. The
  //   serialization shows up under loss; this test asserts the
  //   no-loss baseline matches UDP (no false stalls).
  const { send, advance, delivered } = makeSim(
    'tcp-hol',
    { owDelayMs: 50, jitterMs: 0, lossPct: 0 },
    [0.5],
  );
  send(1);
  send(2);
  send(3);
  advance(49);
  assert.equal(delivered.length, 0);
  advance(1);
  assert.equal(delivered.length, 3);
});

test('tcp-hol: a "lost" packet adds RTT and stalls everything behind it', () => {
  // owDelay = 50ms (RTT = 100ms), 50% loss but rng forces specific
  // decisions. Per send the rng draws [jitter, lossDecide]:
  //   send #1: jitter = 0.5 (= 0), loss decide = 0.99 (no drop)
  //   send #2: jitter = 0.5 (= 0), loss decide = 0.0  (DROP → +100ms)
  //   send #3: jitter = 0.5 (= 0), loss decide = 0.99 (no drop)
  const { send, advance, delivered } = makeSim(
    'tcp-hol',
    { owDelayMs: 50, jitterMs: 0, lossPct: 50 },
    [0.5, 0.99, 0.5, 0.0, 0.5, 0.99],
  );
  send(1); // delivery = 50
  send(2); // delivery = max(50, 50) + 100 retransmit = 150 → nextReadyAt 150
  send(3); // delivery = max(50, 150) = 150
  advance(50);
  // p1 should be out; p2 + p3 stuck behind the simulated retransmit.
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]![0], 1);
  advance(99);
  assert.equal(delivered.length, 1, 'still waiting on retransmit at t=149');
  advance(1); // total 150
  assert.equal(delivered.length, 3, 'p2 and p3 release together at t=150');
});

test('tcp-hol: separate instances do not interfere', () => {
  // Two sims sharing nothing — different profiles, no drops in either.
  // Pattern repeats so we don't run out of values.
  const a = makeSim('tcp-hol', { owDelayMs: 30, jitterMs: 0, lossPct: 0 }, [0.5, 0.99]);
  const b = makeSim('tcp-hol', { owDelayMs: 70, jitterMs: 0, lossPct: 0 }, [0.5, 0.99]);
  a.send(1);
  b.send(2);
  a.advance(30);
  b.advance(30);
  assert.equal(a.delivered.length, 1);
  assert.equal(b.delivered.length, 0);
  b.advance(40); // total 70
  assert.equal(b.delivered.length, 1);
});

test('setProfile updates loss/delay live', () => {
  const { sim, send, advance, delivered } = makeSim(
    'udp',
    { owDelayMs: 0, jitterMs: 0, lossPct: 100 },
    [0],
  );
  send(1);
  assert.equal(delivered.length, 0, 'dropped under 100% loss');
  sim.setProfile({ owDelayMs: 0, jitterMs: 0, lossPct: 0 });
  send(2);
  advance(0);
  assert.equal(delivered.length, 1, 'delivered after profile flipped to 0% loss');
});
