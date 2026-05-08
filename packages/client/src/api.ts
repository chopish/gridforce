// Thin HTTP client for the lobby endpoints. Sits next to Socket.ts (WS) and
// is only used by Lobby.ts during the join/create dance — once the WS opens,
// no further HTTP calls happen.

import { SERVER_HTTP } from './config.js';

export interface PublicRoomSummary {
  code: string;
  name: string;
  players: number;
  maxPlayers: number;
}

export interface CreateRoomBody {
  name?: string;
  visibility: 'public' | 'unlisted' | 'private';
  maxPlayers?: number;
}

export interface CreateRoomResult {
  code: string;
  name: string;
  visibility: 'public' | 'unlisted' | 'private';
  maxPlayers: number;
  // Present only for private rooms — single-use access key the host uses to
  // join the room they just created without redeeming an invite they don't
  // have yet.
  hostAccessKey: string | null;
}

export interface InviteResult {
  token: string;
  maxUses: number;
  expiresAtMs: number;
}

export interface AccessResult {
  code: string;
  accessKey: string;
  name?: string;
}

export class LobbyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `${status} ${code}`);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { bearer?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.bearer) headers.authorization = `Bearer ${init.bearer}`;
  const res = await fetch(`${SERVER_HTTP}${path}`, { ...init, headers });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {}
    throw new LobbyApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export function listPublicRooms(): Promise<{ rooms: PublicRoomSummary[] }> {
  return request('/rooms');
}

export function createRoom(body: CreateRoomBody): Promise<CreateRoomResult> {
  return request('/rooms', { method: 'POST', body: JSON.stringify(body) });
}

export function requestAccess(code: string): Promise<AccessResult> {
  return request(`/rooms/${encodeURIComponent(code)}/access`, { method: 'POST' });
}

export function redeemInvite(token: string): Promise<AccessResult> {
  return request(`/invites/${encodeURIComponent(token)}/redeem`, { method: 'POST' });
}

// Host-gated. Pass the bearer sessionKey (received in Welcome).
export function createInvite(
  code: string,
  bearer: string,
  body: { maxUses?: number; ttlMs?: number } = {},
): Promise<InviteResult> {
  return request(`/rooms/${encodeURIComponent(code)}/invites`, {
    method: 'POST',
    body: JSON.stringify(body),
    bearer,
  });
}
