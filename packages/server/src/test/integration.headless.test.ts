import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  NETSIM_PROFILES,
  PLAYER_MOVE_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
  PREDICTION_HARD_SNAP_PX,
  type NetSimProfile,
} from '@gridforce/shared';

import { AccessKeyStore } from '../AccessKeyStore.js';
import { InviteStore } from '../InviteStore.js';
import { RoomManager } from '../RoomManager.js';
import { SessionStore } from '../SessionStore.js';
import { attachWsHandler } from '../wsHandler.js';
import { TestClient } from './TestClient.js';

// End-to-end netcode test. Spins up a real HTTP+WS server, connects 4 in-process
// WebSocket clients through the network simulator, runs a fixed duration per
// network profile, and asserts on divergence + bandwidth + ack health.
//
// Quick mode (default) runs a small subset of profiles for ~3s each — enough
// to catch regressions on every CI run. Set GRIDFORCE_LONG=1 to run the full
// matrix at 60s per profile (this is the spec's manual validation matrix and
// is too slow for default CI).

const LONG = process.env.GRIDFORCE_LONG === '1';
const PROFILES_QUICK: Array<{ name: string; profile: NetSimProfile }> = [
  { name: 'off', profile: NETSIM_PROFILES.off! },
  { name: 'good', profile: NETSIM_PROFILES.good! },
  { name: 'fair', profile: NETSIM_PROFILES.fair! },
  { name: 'bad', profile: NETSIM_PROFILES.bad! },
];
const PROFILES_LONG: Array<{ name: string; profile: NetSimProfile }> = Object.entries(
  NETSIM_PROFILES,
).map(([name, profile]) => ({ name, profile }));
const PROFILES = LONG ? PROFILES_LONG : PROFILES_QUICK;
const DURATION_MS = LONG ? 60_000 : 3_000;
const CLIENT_COUNT = 4;
// Bandwidth budget per the spec (8 KB/s downstream Phase 0).
const BANDWIDTH_BUDGET_BYTES_PER_SEC = 8 * 1024;

// node:test test timeout — give the long profiles enough room.
const TEST_TIMEOUT_MS = (DURATION_MS + 10_000) * (LONG ? 1.5 : PROFILES.length + 1);

interface RunResult {
  profileName: string;
  durationMs: number;
  perClient: Array<{
    bytesReceived: number;
    snapshotsReceived: number;
    bytesPerSec: number;
    maxLocalDivergencePx: number;
    finalLocalPosition: { x: number; y: number };
  }>;
  serverCpuPct: number;
}

async function startServerOnEphemeralPort(): Promise<{
  url: string;
  manager: RoomManager;
  shutdown: () => Promise<void>;
}> {
  const app = express();
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  const httpServer = createServer(app);
  const manager = new RoomManager();
  const invites = new InviteStore();
  const accessKeys = new AccessKeyStore();
  const sessions = new SessionStore();
  manager.start();
  invites.start();
  accessKeys.start();
  attachWsHandler(httpServer, { manager, invites, accessKeys, sessions });

  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}/ws`;

  return {
    url,
    manager,
    shutdown: async () => {
      manager.stop();
      invites.stop();
      accessKeys.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function runProfile(
  url: string,
  manager: RoomManager,
  profileName: string,
  profile: NetSimProfile,
): Promise<RunResult> {
  // Each profile gets its own room so they're independent. Rooms must be
  // explicitly created post-RoomManager-refactor — auto-create-on-WS is gone.
  // Skip the lobby phase so test clients can move immediately; we're not
  // exercising lobby behavior here.
  const room = manager.createRoom({ visibility: 'unlisted' });
  room.phase = 'playing';
  const roomCode = room.code;
  const clients: TestClient[] = [];
  for (let i = 0; i < CLIENT_COUNT; i++) {
    const c = new TestClient({
      url,
      roomCode,
      name: `c${i}`,
      profile,
      drive: makeDrive(i),
    });
    await c.connect();
    clients.push(c);
  }
  for (const c of clients) c.start();

  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  await new Promise<void>((r) => setTimeout(r, DURATION_MS));
  const wallEnd = performance.now();
  const cpuEnd = process.cpuUsage(cpuStart);

  for (const c of clients) c.stop();

  const wallElapsedMs = wallEnd - wallStart;
  const cpuElapsedMs = (cpuEnd.user + cpuEnd.system) / 1000;
  // Loose CPU% — divides total node CPU (server + 4 clients + sim) by wall.
  // Strict per-room measurement is hard from outside the process; this is a
  // coarse smoke that we're not in a runaway loop.
  const totalCpuPct = (cpuElapsedMs / wallElapsedMs) * 100;

  const perClient = clients.map((c) => {
    const s = c.getStats();
    return {
      bytesReceived: s.bytesReceived,
      snapshotsReceived: s.snapshotsReceived,
      bytesPerSec: (s.bytesReceived * 1000) / wallElapsedMs,
      maxLocalDivergencePx: s.maxLocalDivergencePx,
      finalLocalPosition: s.finalLocalPosition,
    };
  });

  // Give the server a moment to garbage-collect this room before next profile.
  await new Promise<void>((r) => setTimeout(r, 200));

  return {
    profileName,
    durationMs: wallElapsedMs,
    perClient,
    serverCpuPct: totalCpuPct,
  };
}

function makeDrive(seed: number): (tick: number) => { mx: number; my: number; dash: boolean; sprint: boolean } {
  // Each client circles with a different phase so they don't all stack.
  const phase = (seed / CLIENT_COUNT) * Math.PI * 2;
  return (tick: number) => {
    const theta = phase + (tick / 180) * Math.PI * 2;
    return { mx: Math.cos(theta), my: Math.sin(theta), dash: false, sprint: false };
  };
}

test(
  'headless integration: 4 clients × network profiles',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { url, manager, shutdown } = await startServerOnEphemeralPort();
    try {
      const results: RunResult[] = [];
      for (const { name, profile } of PROFILES) {
        const r = await runProfile(url, manager, name, profile);
        results.push(r);
      }

      // Pretty print results so the test log is useful even when it passes.
      for (const r of results) {
        const perClient = r.perClient
          .map(
            (c, i) =>
              `c${i}: ${c.bytesPerSec.toFixed(0)} B/s, ${c.snapshotsReceived} snaps, max-div ${c.maxLocalDivergencePx.toFixed(1)}px`,
          )
          .join('\n    ');
        console.log(`[${r.profileName}] ${r.durationMs.toFixed(0)}ms\n    ${perClient}`);
      }

      // Hard assertions per profile.
      //
      // Divergence semantics: with smooth correction, divergence < HARD_SNAP_PX
      // (30px) is invisible — it gets blended out over PREDICTION_BLEND_MS.
      // Above that, the design intentionally hard-snaps as a backstop. On good
      // networks this should never happen; on bad networks (10% loss, 300ms
      // RTT) one lost input adds ~7px of compounding divergence so occasional
      // hard-snap bursts are expected and acceptable. We assert strictly on
      // good profiles and loosely on bad ones.
      const STRICT_PROFILES = new Set(['off', 'lan', 'good', 'fair']);
      const HARD_DEGRADED_BUDGET_PX = 120; // ~16 missed-input ticks; well past any reasonable burst.
      for (const r of results) {
        for (const [i, c] of r.perClient.entries()) {
          assert.ok(
            c.snapshotsReceived > 0,
            `[${r.profileName}] client ${i} received no snapshots`,
          );
        }

        const isStrict = STRICT_PROFILES.has(r.profileName);
        const divBudget = isStrict ? PREDICTION_HARD_SNAP_PX : HARD_DEGRADED_BUDGET_PX;
        for (const [i, c] of r.perClient.entries()) {
          assert.ok(
            c.maxLocalDivergencePx <= divBudget,
            `[${r.profileName}] client ${i} divergence ${c.maxLocalDivergencePx.toFixed(1)}px exceeds budget ${divBudget}px`,
          );
        }

        // Bandwidth budget: 8 KB/s downstream per client. Loosen by 2× on
        // short tests because per-frame overhead dominates with few snapshots.
        const budget = LONG ? BANDWIDTH_BUDGET_BYTES_PER_SEC : BANDWIDTH_BUDGET_BYTES_PER_SEC * 2;
        for (const [i, c] of r.perClient.entries()) {
          assert.ok(
            c.bytesPerSec <= budget,
            `[${r.profileName}] client ${i} bandwidth ${c.bytesPerSec.toFixed(0)} B/s exceeds budget ${budget} B/s`,
          );
        }
      }
    } finally {
      await shutdown();
    }
  },
);

// Integration test: sprint flag survives 10% outgoing input loss via 3-tick
// redundancy.
//
// Strategy: run a sprint client and a walk client simultaneously under the same
// 10% outgoing input loss profile. Both clients suffer identical timing races
// and identical proportional loss; the only difference is the sprint flag. We
// assert that the sprint client moves meaningfully further than the walk client
// over the same time window.
//
// Two-client ratio approach eliminates sensitivity to the absolute number of
// null-input startup ticks (which depends on server tick offset) — both clients
// experience the same null-tick penalty, so the ratio isolates the sprint flag.
//
// Profile: lossPct=10, owDelayMs=0, jitterMs=0.
//   With INPUT_REDUNDANCY=3: per-tick miss rate = 0.1³ = 0.1%.
//   OWD=0 keeps inputs in the same event-loop phase so the input lead is fully
//   effective without delaying the ws.send() relative to the server tick timer.
//
// Grid: large-run (2304 px wide). Sprinter spawns at x≈1152.
//   Sprint-right for 2 s: 1152 + ~640 = ~1792 < 2292 (maxX). No wall clamping.
//   Walk-right for 2 s:   1152 + ~440 = ~1592. Also safe.
//
// Both clients are connected immediately after the 2-second warmup so they
// share the same startTick and experience identical event-loop conditions.
// Server states are read before stop() to avoid room.remove() → states.delete().
const SPRINT_LOSS_PROFILE: NetSimProfile = { owDelayMs: 0, jitterMs: 0, lossPct: 10 };
const SPRINT_LOSS_DURATION_MS = 2_000;

test('sprint flag survives 10% input loss via redundancy', { timeout: 25_000 }, async () => {
  const { url, manager, shutdown } = await startServerOnEphemeralPort();
  try {
    const room = manager.createRoom({ visibility: 'unlisted' });
    const roomCode = room.code;

    // Lobby → large-run → start game so there are no wall issues on the wider grid.
    const host = new TestClient({
      url,
      roomCode,
      name: 'host',
      drive: () => ({ mx: 0, my: 0, dash: false, sprint: false }),
    });
    await host.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const hostId = room.hostId;
    assert.notEqual(hostId, 0xff, 'host client must be assigned');
    room.setLobbySettings(hostId, 'large-run', 1);
    assert.equal(room.startGame(hostId), true, 'startGame must succeed');
    assert.equal(room.grid.cols, 36, 'large-run must be active (36 cols)');

    // Warmup: let the room tick for 2 s so the server tick is well into the
    // future relative to the test clients' predictedTick leads.
    host.start();
    await new Promise<void>((r) => setTimeout(r, 2_000));

    // Connect sprint and walk clients simultaneously. Same profile = same
    // timing conditions. Both drive rightward, one with sprint, one without.
    const sprint = new TestClient({
      url,
      roomCode,
      name: 'sprinter',
      profile: SPRINT_LOSS_PROFILE,
      drive: () => ({ mx: 1, my: 0, dash: false, sprint: true }),
    });
    const walk = new TestClient({
      url,
      roomCode,
      name: 'walker',
      profile: SPRINT_LOSS_PROFILE,
      drive: () => ({ mx: 1, my: 0, dash: false, sprint: false }),
    });
    await sprint.connect();
    await walk.connect();

    const sprintSpawnX = sprint.getStats().finalLocalPosition.x;
    const walkSpawnX = walk.getStats().finalLocalPosition.x;

    sprint.start();
    walk.start();
    await new Promise<void>((r) => setTimeout(r, SPRINT_LOSS_DURATION_MS));

    // Drain in-flight packets then read server state BEFORE stop() —
    // stop() triggers room.remove() → states.delete().
    await new Promise<void>((r) => setTimeout(r, 200));
    const allStates = Array.from(room.states.values());
    sprint.stop();
    walk.stop();
    host.stop();

    const sprinterState = allStates.find((s) => s.name === 'sprinter');
    const walkerState = allStates.find((s) => s.name === 'walker');
    assert.ok(sprinterState != null, 'sprinter must still be in room.states after drain');
    assert.ok(walkerState != null, 'walker must still be in room.states after drain');

    const sprintDist = sprinterState.x - sprintSpawnX;
    const walkDist = walkerState.x - walkSpawnX;

    console.log(
      `[sprint-loss] sprintDist=${sprintDist.toFixed(1)} walkDist=${walkDist.toFixed(1)} ` +
        `ratio=${walkDist > 0 ? (sprintDist / walkDist).toFixed(3) : 'n/a'} ` +
        `grid=${room.grid.cols}x${room.grid.rows}`,
    );

    // Sprint must travel meaningfully further than walk under the same 10%
    // input loss. Expected ratio ≈ PLAYER_SPRINT_MULTIPLIER = 1.6×. Allow for
    // startup null-ticks and jitter; require at least 1.2×.
    assert.ok(
      sprintDist > walkDist * 1.2,
      `sprint should outrun walk even with 10% input loss via redundancy: ` +
        `sprintDist=${sprintDist.toFixed(1)}, walkDist=${walkDist.toFixed(1)} ` +
        `ratio=${walkDist > 0 ? (sprintDist / walkDist).toFixed(3) : 'n/a'} ` +
        `(expected ratio ≈ ${PLAYER_SPRINT_MULTIPLIER})`,
    );
  } finally {
    await shutdown();
  }
});

// Regression test for tethered-spawn bug: a client joining a room that has
// already been ticking for a while must still be able to move. The fix is
// the INPUT_LEAD_TICKS lead — without it the late-joiner's inputs land in
// the server's past and get dropped, leaving the player oscillating around
// spawn while smooth-correction repeatedly snaps them back.
test('late-joining client can actually move', { timeout: 15_000 }, async () => {
  const { url, manager, shutdown } = await startServerOnEphemeralPort();
  try {
    const room = manager.createRoom({ visibility: 'unlisted' });
    room.phase = 'playing';
    const roomCode = room.code;
    // First, join a "warm-up" client just to let the room tick for a while.
    const warmup = new TestClient({
      url,
      roomCode,
      name: 'warm',
      drive: () => ({ mx: 0, my: 0, dash: false, sprint: false }), // idle
    });
    await warmup.connect();
    warmup.start();
    // Let the room run for ~2s so its server tick is well into the hundreds.
    await new Promise<void>((r) => setTimeout(r, 2_000));

    // Now connect the late-joiner. It will see a startTick deep into room life.
    const late = new TestClient({
      url,
      roomCode,
      name: 'late',
      drive: () => ({ mx: 1, my: 0, dash: false, sprint: false }),
    });
    await late.connect();
    const spawnX = late.getStats().finalLocalPosition.x;
    late.start();
    await new Promise<void>((r) => setTimeout(r, 2_000));
    late.stop();
    warmup.stop();

    const finalX = late.getStats().finalLocalPosition.x;
    const dx = finalX - spawnX;
    // 2s of rightward walk at PLAYER_MOVE_SPEED → ~440 px. Even allowing for
    // boundary clamping and reconcile, we should be well past 100 px from
    // spawn. Tethered-bug behavior would leave dx ≈ 0.
    assert.ok(
      Math.abs(dx) > 100,
      `late joiner only moved ${dx.toFixed(1)} px (expected > 100 px) — looks like the tethered-spawn bug regressed`,
    );
    // Sanity check: bound the upper end too — 2 seconds at PLAYER_MOVE_SPEED
    // is ~440 px, plus any displacement allowed by initial spawn position.
    assert.ok(
      Math.abs(dx) <= PLAYER_MOVE_SPEED * 2.5,
      `late joiner moved ${dx.toFixed(1)} px — implausibly fast, sim is broken`,
    );
  } finally {
    await shutdown();
  }
});
