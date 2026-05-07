import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// One-shot bearer keys handed out by HTTP redemption and consumed by the WS
// handshake. Bridges the HTTP "you may join room X" decision to the WS
// "actually attaching now" moment without putting auth state on the WS
// listener itself.
//
// Keys are short-lived (60s default). Reissuing on every page-load is fine —
// the user just clicks the invite link again. The lifetime intentionally
// covers slow connections + a name-prompt step but not a "leave the tab open
// for hours and rejoin" workflow.

const DEFAULT_TTL_MS = 60_000;
const TOKEN_BYTES = 12;

interface KeyRecord {
  roomCode: string;
  // If the key was minted from an invite, hold the token so the WS handler
  // can decrement usesRemaining once the slot actually attaches.
  inviteToken: string | null;
  expiresAtMs: number;
}

export class AccessKeyStore {
  private keys = new Map<string, KeyRecord>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gc(), 30_000);
  }

  stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
    this.keys.clear();
  }

  issue(opts: { roomCode: string; inviteToken?: string; ttlMs?: number }): string {
    const key = randomBytes(TOKEN_BYTES).toString('base64url');
    this.keys.set(key, {
      roomCode: opts.roomCode,
      inviteToken: opts.inviteToken ?? null,
      expiresAtMs: performance.now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
    });
    return key;
  }

  // Validate-and-consume. Returns the room code + originating invite token
  // (if any) on success; null if the key is missing or expired.
  consume(key: string): { roomCode: string; inviteToken: string | null } | null {
    const rec = this.keys.get(key);
    if (!rec) return null;
    this.keys.delete(key);
    if (performance.now() > rec.expiresAtMs) return null;
    return { roomCode: rec.roomCode, inviteToken: rec.inviteToken };
  }

  private gc(): void {
    const now = performance.now();
    for (const [k, v] of this.keys) {
      if (now > v.expiresAtMs) this.keys.delete(k);
    }
  }
}
