import type { Server as HttpServer } from 'node:http';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import {
  ErrorCode,
  ErrorMsg,
  MessageType,
  SCHEMA_VERSION,
  PongMsg,
  decodeMessage,
} from '@gridforce/shared';

import type { AccessKeyStore } from './AccessKeyStore.js';
import { Connection } from './Connection.js';
import type { InviteStore } from './InviteStore.js';
import type { RoomManager } from './RoomManager.js';
import type { Room } from './Room.js';
import type { SessionStore } from './SessionStore.js';

const HELLO_TIMEOUT_MS = 5_000;

export interface WsDeps {
  manager: RoomManager;
  invites: InviteStore;
  accessKeys: AccessKeyStore;
  sessions: SessionStore;
}

export function attachWsHandler(server: HttpServer, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
  wss.on('connection', (ws: WebSocket) => {
    bootstrap(ws, deps).catch((err) => {
      console.warn('[ws] bootstrap error:', err);
      try {
        ws.close(1011, 'internal');
      } catch {}
    });
  });
  return wss;
}

async function bootstrap(ws: WebSocket, deps: WsDeps): Promise<void> {
  // Disable Nagle for low-latency input.
  // ws exposes the underlying socket via `_socket`; setNoDelay is documented.
  const sock = (ws as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })._socket;
  sock?.setNoDelay?.(true);

  // Wait for the first frame; it must be Hello.
  const hello = await waitForHello(ws);
  if (!hello) return;

  if (hello.schemaVersion !== SCHEMA_VERSION) {
    ws.send(
      ErrorMsg.encode({ code: ErrorCode.SchemaMismatch, message: `expected v${SCHEMA_VERSION}` }),
      { binary: true },
    );
    ws.close(1008, 'schema');
    return;
  }

  const room = deps.manager.findRoom(hello.roomCode);
  if (!room) {
    ws.send(ErrorMsg.encode({ code: ErrorCode.RoomNotFound, message: 'no such room' }), {
      binary: true,
    });
    ws.close(1008, 'room not found');
    return;
  }

  // Visibility-aware access check. The HTTP layer is responsible for issuing
  // access keys (after invite redemption for private, or after a plain GET
  // for public/unlisted). The WS handshake just validates + consumes.
  //
  // For Phase 0 ergonomics, public/unlisted rooms accept an empty accessKey
  // — joining via direct WS (e.g. tests, dev tools, manual reconnect) works
  // without a round-trip to /rooms/:code/access. Private rooms always demand
  // a key. When account auth ships, that empty-key shortcut is the line we
  // tighten.
  let consumedInvite: string | null = null;
  if (room.visibility === 'private') {
    if (!hello.accessKey) {
      reject(ws, ErrorCode.AccessDenied, 'invite required');
      return;
    }
    const consumed = deps.accessKeys.consume(hello.accessKey);
    if (!consumed || consumed.roomCode !== room.code) {
      reject(ws, ErrorCode.AccessDenied, 'invalid or expired invite');
      return;
    }
    consumedInvite = consumed.inviteToken;
  } else if (hello.accessKey) {
    // Public/unlisted with a key supplied: validate it but don't require it.
    // A bad key here is treated as "doesn't match this room" → reject. We
    // don't want to silently fall through to keyless because it'd hide
    // wrong-room redirects from the client.
    const consumed = deps.accessKeys.consume(hello.accessKey);
    if (!consumed || consumed.roomCode !== room.code) {
      reject(ws, ErrorCode.AccessDenied, 'invalid access key');
      return;
    }
  }

  const reservation = room.reserveSlot();
  if (!reservation.ok) {
    ws.send(ErrorMsg.encode({ code: reservation.code, message: 'room full' }), { binary: true });
    ws.close(1008, 'room full');
    return;
  }

  // From here on the join is committed. Decrement the invite's usesRemaining
  // — burning it earlier would let a click that never finishes the handshake
  // consume a use.
  if (consumedInvite) deps.invites.markUsed(consumedInvite);

  // Sanitize name early so it's safe to put in PlayerState (which goes to all
  // clients). 24 chars is the lobby UI's input limit; mirror it server-side.
  const safeName = (hello.name ?? '').replace(/[\x00-\x1f]/g, '').slice(0, 24);

  // Issue a per-connection session key. The Welcome carries it, and the
  // client uses it to authenticate host-gated HTTP calls (invite creation,
  // future room settings) so we can verify "is this caller actually the
  // host of room X?" without an account system.
  const sessionKey = deps.sessions.issue({
    roomCode: room.code,
    playerId: reservation.playerId,
  });

  const conn = new Connection(reservation.playerId, safeName, sessionKey, ws, (c, decoded) =>
    handleConnectionMessage(c, decoded, room, deps.manager),
  );

  // If the socket dies before we commit, undo nothing — we never registered.
  ws.on('close', () => {
    deps.sessions.revoke(sessionKey);
    room.remove(reservation.playerId);
  });

  room.commitJoin(conn);
}

function reject(ws: WebSocket, code: number, message: string): void {
  try {
    ws.send(ErrorMsg.encode({ code, message }), { binary: true });
  } catch {}
  try {
    ws.close(1008, message);
  } catch {}
}

function handleConnectionMessage(
  conn: Connection,
  decoded: ReturnType<typeof decodeMessage>,
  room: Room,
  _manager: RoomManager,
): void {
  switch (decoded.type) {
    case MessageType.Ping: {
      conn.send(
        PongMsg.encode({
          nonce: decoded.payload.nonce,
          clientTimeMs: decoded.payload.clientTimeMs,
          serverTimeMs: Date.now(),
        }),
      );
      return;
    }
    case MessageType.AddBot: {
      room.addBot();
      return;
    }
    case MessageType.SetReady: {
      room.setReady(conn.playerId, decoded.payload.ready);
      return;
    }
    case MessageType.StartGame: {
      room.startGame(conn.playerId);
      return;
    }
    default:
      // Hello mid-stream / unexpected: ignore. Inputs are handled inside Connection itself.
      return;
  }
}

function waitForHello(
  ws: WebSocket,
): Promise<ReturnType<typeof decodeMessage> extends infer R
  ? R extends { type: MessageType.Hello; payload: infer P }
    ? P
    : never
  : never> {
  return new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      ws.removeListener('message', onMsg);
      try {
        ws.close(1008, 'no hello');
      } catch {}
      resolve(null as never);
    }, HELLO_TIMEOUT_MS);

    const onMsg = (data: unknown, isBinary: boolean) => {
      if (done) return;
      if (!isBinary) return;
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (data instanceof Buffer) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else if (Array.isArray(data)) {
        const total = (data as Buffer[]).reduce((n, b) => n + b.byteLength, 0);
        bytes = new Uint8Array(total);
        let off = 0;
        for (const b of data as Buffer[]) {
          bytes.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
          off += b.byteLength;
        }
      } else {
        return;
      }
      let decoded;
      try {
        decoded = decodeMessage(bytes);
      } catch {
        try {
          ws.close(1003, 'bad hello frame');
        } catch {}
        done = true;
        clearTimeout(timeout);
        resolve(null as never);
        return;
      }
      if (decoded.type !== MessageType.Hello) {
        try {
          ws.close(1008, 'expected hello');
        } catch {}
        done = true;
        clearTimeout(timeout);
        resolve(null as never);
        return;
      }
      done = true;
      clearTimeout(timeout);
      ws.removeListener('message', onMsg);
      resolve(decoded.payload as never);
    };

    ws.on('message', onMsg);
  });
}
