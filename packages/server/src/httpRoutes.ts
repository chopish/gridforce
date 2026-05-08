import type { Express, Request, Response } from 'express';
import express from 'express';

import type { AccessKeyStore } from './AccessKeyStore.js';
import type { InviteStore } from './InviteStore.js';
import type { RoomManager } from './RoomManager.js';
import type { Room, RoomVisibility } from './Room.js';
import type { SessionStore } from './SessionStore.js';

// HTTP surface for lobby management, mounted under /api so it sits cleanly
// behind the same nginx /api/ proxy block as everything else dynamic.
//
//   GET  /api/rooms                         list public rooms
//   POST /api/rooms                         create a new room
//   GET  /api/rooms/:code                   peek at an existing room (visibility-aware)
//   POST /api/rooms/:code/access            issue an access key for a public/unlisted room
//   POST /api/rooms/:code/invites           HOST-ONLY: create a fresh invite token
//   POST /api/invites/:token/redeem         redeem an invite, get back room code + access key
//
// Access keys are short-lived bearer tokens consumed by the WS handshake.
// Session keys (issued at WS commitJoin, returned in Welcome) authenticate
// host-gated endpoints via Authorization: Bearer <sessionKey>. There is no
// account auth yet — the (sessionKey, room.hostId) pair is the only check.

export interface HttpDeps {
  manager: RoomManager;
  invites: InviteStore;
  accessKeys: AccessKeyStore;
  sessions: SessionStore;
}

const VALID_VISIBILITIES: ReadonlySet<RoomVisibility> = new Set([
  'public',
  'unlisted',
  'private',
]);

export function attachHttpRoutes(app: Express, deps: HttpDeps): void {
  const router = express.Router();
  router.use(express.json({ limit: '4kb' }));
  attachLobbyRoutes(router, deps);
  app.use('/api', router);
}

// Pull a session record from the Authorization header, validating that it
// resolves to a real session for the room being targeted. Returns null and
// writes the appropriate 401/403 on mismatch — caller should just `return`
// after a null result.
function requireHostSession(
  req: Request,
  res: Response,
  deps: HttpDeps,
  room: Room,
): { ok: true } | { ok: false } {
  const auth = req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    res.status(401).json({ error: 'unauthenticated' });
    return { ok: false };
  }
  const session = deps.sessions.get(m[1]!);
  if (!session) {
    res.status(401).json({ error: 'session_invalid' });
    return { ok: false };
  }
  if (session.roomCode !== room.code) {
    res.status(403).json({ error: 'wrong_room' });
    return { ok: false };
  }
  if (session.playerId !== room.hostId) {
    res.status(403).json({ error: 'host_only' });
    return { ok: false };
  }
  return { ok: true };
}

function attachLobbyRoutes(app: express.Router, deps: HttpDeps): void {
  app.get('/rooms', (_req, res) => {
    res.json({ rooms: deps.manager.listPublic() });
  });

  app.post('/rooms', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const visibility =
      typeof body.visibility === 'string' && VALID_VISIBILITIES.has(body.visibility as RoomVisibility)
        ? (body.visibility as RoomVisibility)
        : 'unlisted';
    const name = typeof body.name === 'string' ? body.name.slice(0, 32) : '';
    const maxPlayers =
      typeof body.maxPlayers === 'number' ? Math.floor(body.maxPlayers) : undefined;

    const createOpts: { name: string; visibility: RoomVisibility; maxPlayers?: number } = {
      name,
      visibility,
    };
    if (maxPlayers !== undefined) createOpts.maxPlayers = maxPlayers;
    const room = deps.manager.createRoom(createOpts);

    // For private rooms, hand the creator a one-shot access key so they can
    // walk through the WS handshake without needing to redeem an invite they
    // haven't generated yet. Guest invites are created later from inside the
    // lobby via POST /api/rooms/:code/invites once the host is connected.
    let hostAccessKey: string | null = null;
    if (visibility === 'private') {
      hostAccessKey = deps.accessKeys.issue({ roomCode: room.code });
    }

    res.json({
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      maxPlayers: room.maxPlayers,
      hostAccessKey,
    });
  });

  app.get('/rooms/:code', (req, res) => {
    const room = deps.manager.findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'not_found' });
    if (room.visibility === 'private') return res.status(404).json({ error: 'not_found' });
    return res.json({
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      players: room.playerCount,
      maxPlayers: room.maxPlayers,
    });
  });

  app.post('/rooms/:code/access', (req, res) => {
    const room = deps.manager.findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'not_found' });
    if (room.visibility === 'private') {
      return res.status(403).json({ error: 'requires_invite' });
    }
    if (room.playerCount >= room.maxPlayers) {
      return res.status(409).json({ error: 'room_full' });
    }
    const accessKey = deps.accessKeys.issue({ roomCode: room.code });
    return res.json({ code: room.code, accessKey });
  });

  // Host-gated invite creation. The host generates fresh invite links from
  // inside the lobby — no longer baked into room creation. Each call mints
  // a brand-new token; defaults are sane for a single friend (1 use, 7d).
  app.post('/rooms/:code/invites', (req, res) => {
    const room = deps.manager.findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'not_found' });
    const auth = requireHostSession(req, res, deps, room);
    if (!auth.ok) return undefined;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxUses =
      typeof body.maxUses === 'number' ? Math.floor(body.maxUses) : undefined;
    const ttlMs = typeof body.ttlMs === 'number' ? Math.floor(body.ttlMs) : undefined;
    const opts: { roomCode: string; maxUses?: number; ttlMs?: number } = {
      roomCode: room.code,
    };
    if (maxUses !== undefined) opts.maxUses = maxUses;
    if (ttlMs !== undefined) opts.ttlMs = ttlMs;
    const rec = deps.invites.create(opts);
    return res.json({
      token: rec.token,
      maxUses: rec.maxUses,
      expiresAtMs: rec.expiresAtMs,
    });
  });

  app.post('/invites/:token/redeem', (req: Request, res: Response) => {
    const token = req.params.token ?? '';
    if (!token) return res.status(400).json({ error: 'missing_token' });
    const peek = deps.invites.peek(token);
    if (!peek.ok) return res.status(404).json({ error: peek.reason });
    const room = deps.manager.findRoom(peek.roomCode);
    if (!room) return res.status(410).json({ error: 'room_gone' });
    if (room.playerCount >= room.maxPlayers) {
      return res.status(409).json({ error: 'room_full' });
    }
    const accessKey = deps.accessKeys.issue({
      roomCode: room.code,
      inviteToken: token,
    });
    return res.json({
      code: room.code,
      name: room.name,
      accessKey,
    });
  });
}
