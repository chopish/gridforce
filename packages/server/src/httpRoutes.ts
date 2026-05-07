import type { Express, Request, Response } from 'express';
import express from 'express';

import type { AccessKeyStore } from './AccessKeyStore.js';
import type { InviteStore } from './InviteStore.js';
import type { RoomManager } from './RoomManager.js';
import type { RoomVisibility } from './Room.js';

// HTTP surface for lobby management, mounted under /api so it sits cleanly
// behind the same nginx /api/ proxy block as everything else dynamic.
//
//   GET  /api/rooms                         list public rooms
//   POST /api/rooms                         create a new room
//   GET  /api/rooms/:code                   peek at an existing room (visibility-aware)
//   POST /api/rooms/:code/access            issue an access key for a public/unlisted room
//   POST /api/invites/:token/redeem         redeem an invite, get back room code + access key
//
// Access keys are short-lived bearer tokens consumed by the WS handshake.
// Anything written here is intentionally minimal — auth lands in a later
// pass when accounts ship.

export interface HttpDeps {
  manager: RoomManager;
  invites: InviteStore;
  accessKeys: AccessKeyStore;
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
    const inviteMaxUses =
      typeof body.inviteMaxUses === 'number' ? Math.floor(body.inviteMaxUses) : undefined;
    const inviteTtlMs =
      typeof body.inviteTtlMs === 'number' ? Math.floor(body.inviteTtlMs) : undefined;

    const createOpts: { name: string; visibility: RoomVisibility; maxPlayers?: number } = {
      name,
      visibility,
    };
    if (maxPlayers !== undefined) createOpts.maxPlayers = maxPlayers;
    const room = deps.manager.createRoom(createOpts);
    let invite: { token: string; maxUses: number; expiresAtMs: number } | null = null;
    if (visibility === 'private') {
      const inviteOpts: { roomCode: string; maxUses?: number; ttlMs?: number } = {
        roomCode: room.code,
      };
      if (inviteMaxUses !== undefined) inviteOpts.maxUses = inviteMaxUses;
      if (inviteTtlMs !== undefined) inviteOpts.ttlMs = inviteTtlMs;
      const rec = deps.invites.create(inviteOpts);
      invite = {
        token: rec.token,
        maxUses: rec.maxUses,
        expiresAtMs: rec.expiresAtMs,
      };
    }
    res.json({
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      maxPlayers: room.maxPlayers,
      invite,
    });
  });

  app.get('/rooms/:code', (req, res) => {
    const room = deps.manager.findRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'not_found' });
    // Don't expose private rooms by code lookup at all — they should appear
    // not-found to anyone without an invite token. Unlisted is fine to peek
    // at if you guessed the code (its whole purpose).
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
      // Private rooms must come through /invites/:token/redeem instead.
      return res.status(403).json({ error: 'requires_invite' });
    }
    if (room.playerCount >= room.maxPlayers) {
      return res.status(409).json({ error: 'room_full' });
    }
    const accessKey = deps.accessKeys.issue({ roomCode: room.code });
    return res.json({ code: room.code, accessKey });
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
