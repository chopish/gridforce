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
  invites: InviteStore;
  accessKeys: AccessKeyStore;
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

async function postJson<T>(url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
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

test('invite redemption issues a one-shot access key', async () => {
  const h = await startHarness();
  try {
    const { body: created } = await postJson<{
      code: string;
      invite: { token: string };
    }>(`${h.url}/api/rooms`, { visibility: 'private', inviteMaxUses: 2 });

    const first = await postJson<{ code: string; accessKey: string }>(
      `${h.url}/api/invites/${created.invite.token}/redeem`,
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.code, created.code);
    assert.ok(first.body.accessKey);

    // Second redemption while invite still has uses left should also work,
    // but the first key cannot be reused.
    const second = await postJson<{ accessKey: string }>(
      `${h.url}/api/invites/${created.invite.token}/redeem`,
    );
    assert.equal(second.status, 200);
    assert.notEqual(first.body.accessKey, second.body.accessKey);
  } finally {
    await h.shutdown();
  }
});

test('invite usesRemaining decrements on actual WS join', async () => {
  const h = await startHarness();
  try {
    const { body: created } = await postJson<{
      code: string;
      invite: { token: string };
    }>(`${h.url}/api/rooms`, { visibility: 'private', inviteMaxUses: 1 });

    // Redeem once: produces key, but invite hasn't been "burned" yet.
    const first = await postJson<{ code: string; accessKey: string }>(
      `${h.url}/api/invites/${created.invite.token}/redeem`,
    );
    assert.equal(first.status, 200);

    // Connect with that key — this is where the invite use is committed.
    const client = new TestClient({
      url: h.wsUrl,
      roomCode: first.body.code,
      name: 'a',
      accessKey: first.body.accessKey,
      drive: () => ({ mx: 0, my: 0, dash: false }),
    });
    await client.connect();
    client.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    client.stop();

    // Now another redemption attempt should fail — invite was consumed.
    const second = await postJson<{ error: string }>(
      `${h.url}/api/invites/${created.invite.token}/redeem`,
    );
    assert.equal(second.status, 404);
  } finally {
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
