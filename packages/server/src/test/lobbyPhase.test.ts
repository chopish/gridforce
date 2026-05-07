import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AccessKeyStore } from '../AccessKeyStore.js';
import { InviteStore } from '../InviteStore.js';
import { RoomManager } from '../RoomManager.js';
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
  manager.start();
  invites.start();
  accessKeys.start();
  attachHttpRoutes(app, { manager, invites, accessKeys });
  const httpServer: HttpServer = createServer(app);
  attachWsHandler(httpServer, { manager, invites, accessKeys });
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

test('Room defaults to lobby phase; first joiner becomes host', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    assert.equal(room.phase, 'lobby');
    assert.equal(room.hostId, 0xff);

    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'host',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal(room.phase, 'lobby');
    assert.equal(room.playerCount, 1);
    assert.notEqual(room.hostId, 0xff);
    c.stop();
  } finally {
    await h.shutdown();
  }
});

test('Player movement is frozen in lobby phase', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      // Drive hard to the right; in lobby the server must ignore the input.
      drive: () => ({ mx: 1, my: 0, dash: false }),
    });
    await c.connect();
    const startX = c.getStats().finalLocalPosition.x;
    c.start();
    await new Promise<void>((r) => setTimeout(r, 1500));
    c.stop();
    const endX = c.getStats().finalLocalPosition.x;
    // Server held the player at spawn — the client's prediction may have
    // wandered, but the authoritative position should not have. Allow a
    // small slack for client-only prediction noise.
    const players = Array.from(room.states.values());
    assert.equal(players.length, 1);
    assert.ok(
      Math.abs(players[0]!.x - startX) < 1,
      `server-side x stayed at spawn (start=${startX}, server=${players[0]!.x})`,
    );
    void endX;
  } finally {
    await h.shutdown();
  }
});

test('startGame is host-only; a non-host call is rejected', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    // Pretend playerId 5 (no such player) tries to start.
    assert.equal(room.startGame(5), false);
    assert.equal(room.phase, 'lobby');

    // Now seat a host and try with the wrong id.
    const a = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'host',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await a.connect();
    await new Promise<void>((r) => setTimeout(r, 200));
    const hostId = room.hostId;
    assert.notEqual(hostId, 0xff);

    // A different id (non-host) tries to start. 0xfe is a valid even id
    // that's almost certainly not the host (host got the first allocation,
    // typically 0).
    const notHost = hostId === 0xfe ? 0 : 0xfe;
    assert.equal(room.startGame(notHost), false);
    assert.equal(room.phase, 'lobby');
    // The actual host can.
    assert.equal(room.startGame(hostId), true);
    assert.equal(room.phase, 'playing');
    a.stop();
  } finally {
    await h.shutdown();
  }
});

test('host promotion: when host leaves, lowest-id remaining human takes over', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });

    const a = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'a',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await a.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const firstHost = room.hostId;

    const b = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'b',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await b.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    assert.equal(room.hostId, firstHost, 'second joiner does not steal host');

    // Disconnect host. WS close → Room.remove → host should reassign.
    a.stop();
    await new Promise<void>((r) => setTimeout(r, 300));
    assert.notEqual(room.hostId, firstHost);
    assert.notEqual(room.hostId, 0xff, 'a remaining human became host');
    b.stop();
  } finally {
    await h.shutdown();
  }
});

test('Bots cannot become host even when alone', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    room.addBot();
    room.addBot();
    assert.equal(room.hostId, 0xff, 'all-bot room has no host');
  } finally {
    await h.shutdown();
  }
});

test('setReady toggles the pilot flag and is reflected in PlayerState', async () => {
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
    room.setReady(id, true);
    assert.equal(room.states.get(id)!.ready, true);
    assert.equal(room.pilots.get(id)!.ready, true);
    room.setReady(id, false);
    assert.equal(room.states.get(id)!.ready, false);
    c.stop();
  } finally {
    await h.shutdown();
  }
});

test('startGame is idempotent: second call while playing returns false', async () => {
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
    const hostId = room.hostId;
    assert.equal(room.startGame(hostId), true);
    assert.equal(room.startGame(hostId), false);
    assert.equal(room.phase, 'playing');
    c.stop();
  } finally {
    await h.shutdown();
  }
});
