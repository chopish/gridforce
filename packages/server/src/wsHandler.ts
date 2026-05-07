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

import { Connection } from './Connection.js';
import type { RoomManager } from './RoomManager.js';
import type { Room } from './Room.js';

const HELLO_TIMEOUT_MS = 5_000;

export function attachWsHandler(server: HttpServer, manager: RoomManager): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
  wss.on('connection', (ws: WebSocket) => {
    bootstrap(ws, manager).catch((err) => {
      console.warn('[ws] bootstrap error:', err);
      try {
        ws.close(1011, 'internal');
      } catch {}
    });
  });
  return wss;
}

async function bootstrap(ws: WebSocket, manager: RoomManager): Promise<void> {
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

  const room = manager.resolveRoom(hello.roomCode);
  const reservation = room.reserveSlot();
  if (!reservation.ok) {
    ws.send(ErrorMsg.encode({ code: reservation.code, message: 'room full' }), { binary: true });
    ws.close(1008, 'room full');
    return;
  }

  const conn = new Connection(reservation.playerId, ws, (c, decoded) =>
    handleConnectionMessage(c, decoded, room, manager),
  );

  // If the socket dies before we commit, undo nothing — we never registered.
  ws.on('close', () => {
    room.remove(reservation.playerId);
  });

  room.commitJoin(conn);
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
