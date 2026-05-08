import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { PlayerId } from '@gridforce/shared';

// Per-connection bearer tokens used to authenticate the player's HTTP calls
// (invite creation, future host-gated room settings). One key per
// Connection, issued at commitJoin and revoked on disconnect.
//
// Authorization model is intentionally minimal — sessions are bound to a
// (roomCode, playerId) pair, so checking "is this caller the host?" is just
// a session lookup followed by a hostId comparison. There's no concept of
// scoped permissions yet; if a session is valid for room X and the caller
// happens to be host of X, every host endpoint accepts it.
//
// Phase 0: in-memory only. When accounts ship, sessions either disappear
// (replaced by account-scoped tokens) or get persisted alongside accounts.

const TOKEN_BYTES = 18; // 144 bits → 24 chars base64url

export interface SessionRecord {
  roomCode: string;
  playerId: PlayerId;
  createdAtMs: number;
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();

  issue(opts: { roomCode: string; playerId: PlayerId }): string {
    const key = randomBytes(TOKEN_BYTES).toString('base64url');
    this.sessions.set(key, {
      roomCode: opts.roomCode,
      playerId: opts.playerId,
      createdAtMs: performance.now(),
    });
    return key;
  }

  get(key: string): SessionRecord | undefined {
    if (!key) return undefined;
    return this.sessions.get(key);
  }

  revoke(key: string): void {
    this.sessions.delete(key);
  }

  // Diagnostic only.
  get size(): number {
    return this.sessions.size;
  }
}
