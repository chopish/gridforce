import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

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
  invites: InviteStore;
  accessKeys: AccessKeyStore;
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
    invites,
    accessKeys,
    shutdown: async () => {
      manager.stop();
      invites.stop();
      accessKeys.stop();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

async function postJson<T>(
  url: string,
  body?: unknown,
  bearer?: string,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

// Create a private room, connect a host TestClient (using the inline host
// access key), and return everything tests need to drive invite operations.
async function startHostedPrivateRoom(h: Harness, roomName = 'host-room'): Promise<{
  code: string;
  host: TestClient;
}> {
  const { body: created } = await postJson<{ code: string; hostAccessKey: string }>(
    `${h.url}/api/rooms`,
    { visibility: 'private', name: roomName },
  );
  const host = new TestClient({
    url: h.wsUrl,
    roomCode: created.code,
    name: 'host',
    accessKey: created.hostAccessKey,
    drive: () => ({ mx: 0, my: 0, dash: false }),
  });
  await host.connect();
  // Welcome has been processed by now, so sessionKey is populated.
  return { code: created.code, host };
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

test('public listing excludes unlisted and private', async () => {
  const h = await startHarness();
  try {
    await postJson(`${h.url}/api/rooms`, { visibility: 'public', name: 'pub' });
    await postJson(`${h.url}/api/rooms`, { visibility: 'unlisted' });
    await postJson(`${h.url}/api/rooms`, { visibility: 'private' });

    const { status, body } = await getJson<{
      rooms: Array<{ code: string; name: string }>;
    }>(`${h.url}/api/rooms`);
    assert.equal(status, 200);
    assert.equal(body.rooms.length, 1);
    assert.equal(body.rooms[0]!.name, 'pub');
  } finally {
    await h.shutdown();
  }
});

test('private rooms are not findable by direct code lookup', async () => {
  const h = await startHarness();
  try {
    const { body: created } = await postJson<{ code: string }>(`${h.url}/api/rooms`, {
      visibility: 'private',
    });
    const { status } = await getJson(`${h.url}/api/rooms/${created.code}`);
    assert.equal(status, 404);
  } finally {
    await h.shutdown();
  }
});

test('access endpoint refuses private rooms', async () => {
  const h = await startHarness();
  try {
    const { body: created } = await postJson<{ code: string }>(`${h.url}/api/rooms`, {
      visibility: 'private',
    });
    const { status, body } = await postJson<{ error: string }>(
      `${h.url}/api/rooms/${created.code}/access`,
    );
    assert.equal(status, 403);
    assert.equal(body.error, 'requires_invite');
  } finally {
    await h.shutdown();
  }
});

test('host can create invites from inside the lobby', async () => {
  const h = await startHarness();
  let host: TestClient | null = null;
  try {
    const seat = await startHostedPrivateRoom(h);
    host = seat.host;
    assert.ok(seat.host.sessionKey, 'host received a session key from Welcome');

    const inv = await postJson<{ token: string; maxUses: number }>(
      `${h.url}/api/rooms/${seat.code}/invites`,
      { maxUses: 2 },
      seat.host.sessionKey,
    );
    assert.equal(inv.status, 200);
    assert.ok(inv.body.token);
    assert.equal(inv.body.maxUses, 2);

    // Each call mints a fresh token.
    const inv2 = await postJson<{ token: string }>(
      `${h.url}/api/rooms/${seat.code}/invites`,
      {},
      seat.host.sessionKey,
    );
    assert.equal(inv2.status, 200);
    assert.notEqual(inv.body.token, inv2.body.token);
  } finally {
    host?.stop();
    await h.shutdown();
  }
});

test('non-host session cannot create invites', async () => {
  const h = await startHarness();
  let host: TestClient | null = null;
  let guest: TestClient | null = null;
  try {
    const seat = await startHostedPrivateRoom(h);
    host = seat.host;

    // Have the host mint a guest invite, then redeem + connect a guest.
    const inv = await postJson<{ token: string }>(
      `${h.url}/api/rooms/${seat.code}/invites`,
      { maxUses: 1 },
      seat.host.sessionKey,
    );
    const redeemed = await postJson<{ accessKey: string; code: string }>(
      `${h.url}/api/invites/${inv.body.token}/redeem`,
    );
    guest = new TestClient({
      url: h.wsUrl,
      roomCode: redeemed.body.code,
      name: 'guest',
      accessKey: redeemed.body.accessKey,
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await guest.connect();
    assert.ok(guest.sessionKey);
    assert.notEqual(guest.sessionKey, seat.host.sessionKey);

    // Guest tries to mint an invite — should be rejected as not-host.
    const denied = await postJson<{ error: string }>(
      `${h.url}/api/rooms/${seat.code}/invites`,
      {},
      guest.sessionKey,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'host_only');

    // Anonymous (no Authorization header) is unauthenticated.
    const anon = await postJson<{ error: string }>(
      `${h.url}/api/rooms/${seat.code}/invites`,
      {},
    );
    assert.equal(anon.status, 401);
  } finally {
    guest?.stop();
    host?.stop();
    await h.shutdown();
  }
});

test('a session key for one room cannot mint invites for another', async () => {
  const h = await startHarness();
  let hostA: TestClient | null = null;
  try {
    const seatA = await startHostedPrivateRoom(h, 'A');
    hostA = seatA.host;
    // A second private room — owned by no one yet from a session standpoint.
    const { body: roomB } = await postJson<{ code: string }>(
      `${h.url}/api/rooms`,
      { visibility: 'private', name: 'B' },
    );
    const cross = await postJson<{ error: string }>(
      `${h.url}/api/rooms/${roomB.code}/invites`,
      {},
      seatA.host.sessionKey,
    );
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error, 'wrong_room');
  } finally {
    hostA?.stop();
    await h.shutdown();
  }
});

test('invite usesRemaining decrements on actual WS join', async () => {
  const h = await startHarness();
  let host: TestClient | null = null;
  let guest: TestClient | null = null;
  try {
    const seat = await startHostedPrivateRoom(h);
    host = seat.host;

    const inv = await postJson<{ token: string }>(
      `${h.url}/api/rooms/${seat.code}/invites`,
      { maxUses: 1 },
      seat.host.sessionKey,
    );

    // Redeem once: produces key, but invite hasn't been "burned" yet.
    const redeemed = await postJson<{ code: string; accessKey: string }>(
      `${h.url}/api/invites/${inv.body.token}/redeem`,
    );
    assert.equal(redeemed.status, 200);

    // Connect with that key — this is where the invite use is committed.
    guest = new TestClient({
      url: h.wsUrl,
      roomCode: redeemed.body.code,
      name: 'guest',
      accessKey: redeemed.body.accessKey,
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await guest.connect();
    guest.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    guest.stop();
    guest = null;

    // Now another redemption attempt should fail — invite was consumed.
    const second = await postJson<{ error: string }>(
      `${h.url}/api/invites/${inv.body.token}/redeem`,
    );
    assert.equal(second.status, 404);
  } finally {
    guest?.stop();
    host?.stop();
    await h.shutdown();
  }
});

test('private room rejects WS join without access key', async () => {
  const h = await startHarness();
  try {
    const { body: created } = await postJson<{ code: string }>(`${h.url}/api/rooms`, {
      visibility: 'private',
    });

    const client = new TestClient({
      url: h.wsUrl,
      roomCode: created.code,
      name: 'noauth',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    let connectFailed = false;
    try {
      await client.connect();
      // Allow the server's reject + close to land before assuming success.
      await new Promise<void>((r) => setTimeout(r, 200));
    } catch {
      connectFailed = true;
    }
    // The client may or may not throw on close; either way the room must be empty.
    client.stop();
    const room = h.manager.findRoom(created.code);
    assert.ok(room);
    assert.equal(room!.playerCount, 0, 'private room rejected the keyless join');
    void connectFailed;
  } finally {
    await h.shutdown();
  }
});

test('unknown room codes are rejected (no auto-create)', async () => {
  const h = await startHarness();
  try {
    const client = new TestClient({
      url: h.wsUrl,
      roomCode: 'NOPE',
      name: 'x',
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    try {
      await client.connect();
      await new Promise<void>((r) => setTimeout(r, 200));
    } catch {}
    client.stop();
    assert.equal(h.manager.findRoom('NOPE'), undefined);
  } finally {
    await h.shutdown();
  }
});
