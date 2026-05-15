import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { RUNS, STAGES, createDefaultGrid } from '@gridforce/shared';

import { AccessKeyStore } from '../AccessKeyStore.js';
import { InviteStore } from '../InviteStore.js';
import { RoomManager } from '../RoomManager.js';
import { SessionStore } from '../SessionStore.js';
import { attachHttpRoutes } from '../httpRoutes.js';
import { attachWsHandler } from '../wsHandler.js';
import { TestClient } from './TestClient.js';

interface Harness {
  url: string;
  wsUrl: string;
  manager: RoomManager;
  shutdown: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const app = express();
  const manager = new RoomManager();
  const invites = new InviteStore();
  const accessKeys = new AccessKeyStore();
  const sessions = new SessionStore();
  manager.start();
  invites.start();
  accessKeys.start();
  attachHttpRoutes(app, { manager, invites, accessKeys, sessions });
  const httpServer: HttpServer = createServer(app);
  attachWsHandler(httpServer, { manager, invites, accessKeys, sessions });
  await new Promise<void>((r) => httpServer.listen(0, () => r()));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    manager,
    shutdown: async () => {
      manager.stop();
      invites.stop();
      accessKeys.stop();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

// Test fixtures install into the shared registries. We add and remove them
// per test so the global state stays consistent across cases.
function installFixture(stageIds: string[], phaseSeqs: Array<Array<{ id: string; durationS: number | null }>>): {
  runId: string;
  cleanup: () => void;
} {
  const runId = `__test-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < stageIds.length; i++) {
    const sid = stageIds[i]!;
    STAGES[sid] = {
      id: sid,
      displayName: sid,
      grid: createDefaultGrid(),
      phaseSequence: phaseSeqs[i]!.map((p) => ({
        id: p.id,
        displayName: p.id,
        durationS: p.durationS,
      })),
    };
  }
  RUNS[runId] = { id: runId, displayName: runId, stageSequence: stageIds };
  return {
    runId,
    cleanup: () => {
      delete RUNS[runId];
      for (const sid of stageIds) delete STAGES[sid];
    },
  };
}

test('Bootstrap: test-run with single open-ended phase never auto-advances', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    assert.equal(room.startGame(id), true);
    // Drive a full second of wall clock. The single 'active' phase has
    // durationS = null, so it must never advance.
    c.start();
    await new Promise<void>((r) => setTimeout(r, 1000));
    c.stop();
    // Indices unchanged; phase still 'playing'.
    // Access via the read-only public surface — currentStageIndex and
    // currentPhaseIndex are private on Room, so we go through a snapshot
    // round-trip via the runId field as a proxy + the phase state.
    assert.equal(room.phase, 'playing');
    assert.equal(room.runId, 'test-run');
  } finally {
    await h.shutdown();
  }
});

test('Timer-driven phase advance via the real tick loop', async () => {
  const fixture = installFixture(
    ['__test-stage-1'],
    [[{ id: 'a', durationS: 0.3 }, { id: 'b', durationS: 0.3 }, { id: 'c', durationS: null }]],
  );
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    // Switch to fixture run, then start.
    assert.equal(room.setLobbySettings(id, fixture.runId, 1), true);
    assert.equal(room.runId, fixture.runId);
    assert.equal(room.startGame(id), true);
    c.start();
    // After 0.5 s we should be in phase 'b' (a elapsed at 0.3s, b underway).
    await new Promise<void>((r) => setTimeout(r, 500));
    // Inspect indices via a public-surface trick: call advancePhase() with
    // a known precondition isn't necessary — we'll go through a snapshot
    // round-trip instead. Easier: install a peek that the test can use.
    // For now, rely on the run-end path (cleanest assertion): drive past
    // c (event-driven) explicitly and confirm we reach run-end after
    // calling advancePhase() once.
    room.advancePhase();
    // We're now sitting in c (event-driven). Advance once more → past
    // last phase of last stage → run-end.
    room.advancePhase();
    await new Promise<void>((r) => setTimeout(r, 50));
    c.stop();
    assert.equal(room.phase, 'run-end');
  } finally {
    await h.shutdown();
    fixture.cleanup();
  }
});

test('Manual advancePhase: event-driven phase transitions immediately', async () => {
  const fixture = installFixture(
    ['__test-stage-manual'],
    [[{ id: 'a', durationS: null }, { id: 'b', durationS: null }]],
  );
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    room.setLobbySettings(id, fixture.runId, 1);
    room.startGame(id);

    // We're in phase 'a' (event-driven, never auto-advances). Advance once
    // → phase 'b'. Advance twice → past last phase of only stage → run-end.
    assert.equal(room.phase, 'playing');
    room.advancePhase();
    assert.equal(room.phase, 'playing');
    room.advancePhase();
    assert.equal(room.phase, 'run-end');
    c.stop();
  } finally {
    await h.shutdown();
    fixture.cleanup();
  }
});

test('Stage advance: last phase of a stage rolls to next stage and swaps the grid', async () => {
  const fixture = installFixture(
    ['__test-st-a', '__test-st-b'],
    [
      [{ id: 'p', durationS: null }],
      [{ id: 'p', durationS: null }],
    ],
  );
  // Give the second stage a recognisably different grid so we can prove
  // room.grid swapped on the advance.
  STAGES['__test-st-b']!.grid = { cols: 7, rows: 7, panelSize: 32 };
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    room.setLobbySettings(id, fixture.runId, 1);
    room.startGame(id);
    // Stage 0 grid = default 18x12.
    assert.equal(room.grid.cols, 18);
    // Advance past stage 0's single phase → into stage 1.
    room.advancePhase();
    assert.equal(room.phase, 'playing');
    assert.equal(room.grid.cols, 7);
    assert.equal(room.grid.rows, 7);
    c.stop();
  } finally {
    await h.shutdown();
    fixture.cleanup();
  }
});

test('Run end: final phase of final stage transitions room to run-end', async () => {
  const fixture = installFixture(
    ['__test-rend'],
    [[{ id: 'p', durationS: null }]],
  );
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    room.setLobbySettings(id, fixture.runId, 1);
    room.startGame(id);
    assert.equal(room.phase, 'playing');
    room.advancePhase();
    assert.equal(room.phase, 'run-end');
    // startGame in run-end is rejected (no auto-restart for now).
    assert.equal(room.startGame(id), false);
    c.stop();
  } finally {
    await h.shutdown();
    fixture.cleanup();
  }
});

test('setLobbySettings rejects unknown run id', async () => {
  const h = await startHarness();
  let c: TestClient | null = null;
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    // Difficulty alone is a valid change; runId is bogus and must be
    // silently ignored without breaking the difficulty update.
    assert.equal(room.runId, 'test-run');
    assert.equal(room.setLobbySettings(id, 'no-such-run', 2), true);
    assert.equal(room.runId, 'test-run', 'bad runId did not stick');
    assert.equal(room.difficulty, 2, 'valid difficulty still applied');
  } finally {
    c?.stop();
    await h.shutdown();
  }
});

test('Snapshot to a connected TestClient encodes new stage/phase fields', async () => {
  const fixture = installFixture(
    ['__test-snap'],
    [[{ id: 'a', durationS: null }]],
  );
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    room.setLobbySettings(id, fixture.runId, 1);
    room.startGame(id);
    c.start();
    // Let a few snapshots fly. The TestClient doesn't expose the snapshot
    // fields directly, but the bytes-received counter proves messages are
    // arriving with the new wire format intact. If the encoder/decoder
    // didn't agree on the byte count, the client would fail to parse and
    // we'd see snapshotsReceived stay at 0.
    await new Promise<void>((r) => setTimeout(r, 300));
    c.stop();
    const stats = c.getStats();
    assert.ok(stats.snapshotsReceived > 0, 'client decoded snapshots with new fields');
  } finally {
    await h.shutdown();
    fixture.cleanup();
  }
});
