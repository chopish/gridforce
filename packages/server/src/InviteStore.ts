import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// In-memory store of invite tokens. Tokens map to a room code, a usage cap,
// and an expiry. Designed to be GC'd in-process — invites die on restart,
// which is acceptable for Phase 0 (rooms are ephemeral anyway). When we add
// account whitelisting, the `allowedAccountIds` field below becomes load-
// bearing; for now it's reserved.
//
// The store does NOT decrement on redeem alone. Redemption issues a one-shot
// access key (see AccessKeyStore) which is consumed by the WS handshake.
// Decrementing here on redeem would let a single click on an invite link
// burn a use without ever joining; instead the key consume is the commit
// point and `redeem` only validates + holds a reservation.

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_BYTES = 12; // 96 bits → ~16 chars base64url

export interface InviteRecord {
  token: string;
  roomCode: string;
  maxUses: number;
  usesRemaining: number;
  createdAtMs: number;
  expiresAtMs: number;
  // Reserved for future account whitelisting. null = anyone with link.
  allowedAccountIds: Set<string> | null;
}

export type RedeemResult =
  | { ok: true; roomCode: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'exhausted' };

export class InviteStore {
  private invites = new Map<string, InviteRecord>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gc(), 60_000);
  }

  stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
    this.invites.clear();
  }

  create(opts: { roomCode: string; maxUses?: number; ttlMs?: number }): InviteRecord {
    const token = mintToken();
    const maxUses = Math.max(1, opts.maxUses ?? 1);
    const ttl = Math.max(60_000, opts.ttlMs ?? DEFAULT_TTL_MS);
    const now = performance.now();
    const rec: InviteRecord = {
      token,
      roomCode: opts.roomCode,
      maxUses,
      usesRemaining: maxUses,
      createdAtMs: now,
      expiresAtMs: now + ttl,
      allowedAccountIds: null,
    };
    this.invites.set(token, rec);
    return rec;
  }

  // Validate a token without consuming a use. Use markUsed() at the moment
  // the WS handshake commits — that's when a "use" actually happened.
  peek(token: string): RedeemResult {
    const rec = this.invites.get(token);
    if (!rec) return { ok: false, reason: 'not_found' };
    if (performance.now() > rec.expiresAtMs) {
      this.invites.delete(token);
      return { ok: false, reason: 'expired' };
    }
    if (rec.usesRemaining <= 0) return { ok: false, reason: 'exhausted' };
    return { ok: true, roomCode: rec.roomCode };
  }

  // Decrement usesRemaining; called from the WS handshake after the access
  // key is consumed and the slot is reserved.
  markUsed(token: string): void {
    const rec = this.invites.get(token);
    if (!rec) return;
    rec.usesRemaining--;
    if (rec.usesRemaining <= 0) this.invites.delete(token);
  }

  get(token: string): InviteRecord | undefined {
    return this.invites.get(token);
  }

  private gc(): void {
    const now = performance.now();
    for (const [k, v] of this.invites) {
      if (now > v.expiresAtMs || v.usesRemaining <= 0) this.invites.delete(k);
    }
  }
}

function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}
