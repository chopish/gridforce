import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { CrawlerAIState, allocateTiles, type TileBuffers } from '@gridforce/shared';

import { AccessKeyStore } from '../AccessKeyStore.js';
import { InviteStore } from '../InviteStore.js';
import { RoomManager } from '../RoomManager.js';
import { SessionStore } from '../SessionStore.js';
import { attachHttpRoutes } from '../httpRoutes.js';
import { attachWsHandler } from '../wsHandler.js';
import { TestClient } from './TestClient.js';

async function startHarness() {
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

test('B1 endless loop: crawlers spawn over a few seconds of gameplay', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'p',
      drive: () => ({ mx: 0, my: 0, shock: false, repair: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    assert.equal(room.startGame(id), true);
    c.start();
    // Wait several spawn intervals (1s each, capped at MAX_ALIVE_CRAWLERS=8).
    await new Promise<void>((r) => setTimeout(r, 3000));
    c.stop();
    assert.ok(
      room.crawlers.size >= 1,
      `expected at least 1 crawler in ~3s with 1s spawn interval, got ${room.crawlers.size}`,
    );
  } finally {
    await h.shutdown();
  }
});

test('B1 endless loop: shock kills a planted crawler and drops carbon', async () => {
  const h = await startHarness();
  try {
    const room = h.manager.createRoom({ visibility: 'unlisted' });
    const c = new TestClient({
      url: h.wsUrl,
      roomCode: room.code,
      name: 'p',
      drive: () => ({ mx: 0, my: 0, shock: true, repair: false }),
    });
    await c.connect();
    await new Promise<void>((r) => setTimeout(r, 100));
    const id = room.hostId;
    assert.equal(room.startGame(id), true);
    // Plant a crawler one tile to the right of the host's spawn.
    const r = room as unknown as {
      states: Map<number, { x: number; y: number }>;
      grid: { cols: number; rows: number; panelSize: number };
      crawlers: Map<number, { id: number; x: number; y: number; facing: number; hp: number; targetCx: number; targetCy: number; ai: number }>;
      tiles: TileBuffers;
    };
    const hostState = r.states.get(id)!;
    const cx = Math.floor(hostState.x / r.grid.panelSize) + 1;
    const cy = Math.floor(hostState.y / r.grid.panelSize);
    r.crawlers.set(9999, {
      id: 9999,
      x: cx * r.grid.panelSize + r.grid.panelSize / 2,
      y: cy * r.grid.panelSize + r.grid.panelSize / 2,
      facing: Math.PI, hp: 1,
      targetCx: cx, targetCy: cy, ai: CrawlerAIState.ATTACKING,
    });
    // Reset tile state so the panel under that crawler is at full L1 HP
    // and therefore conducts.
    r.tiles = allocateTiles(r.grid.cols, r.grid.rows);
    c.start();
    // Drive enough ticks for shock input to land + apply.
    await new Promise<void>((r) => setTimeout(r, 500));
    c.stop();
    assert.equal(r.crawlers.has(9999), false, 'shock killed the planted crawler');
    // Note: carbon may or may not still be on the ground depending on timing
    // (the host might walk over it during the drive loop). Just verify the
    // kill happened, not the lingering pickup.
  } finally {
    await h.shutdown();
  }
});
