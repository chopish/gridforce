import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  decode,
  type ClientMessage,
  type ServerError,
} from '@gridforce/shared';
import { Connection } from './Connection.js';
import type { RoomManager } from './RoomManager.js';

let nextPlayerId = 1;

function sendError(socket: WebSocket, code: ServerError['code'], message: string): void {
  try {
    socket.send(JSON.stringify({ type: 'error', code, message } satisfies ServerError));
  } catch {
    /* socket may be dead */
  }
}

export function handleWsConnection(
  socket: WebSocket,
  req: IncomingMessage,
  rooms: RoomManager,
): void {
  // Pull room code + name from query string. We do this in the handler so
  // we can reject early with a clear error.
  const url = new URL(req.url ?? '/ws', `http://${req.headers.host ?? 'localhost'}`);
  const code = (url.searchParams.get('code') ?? '').toUpperCase();
  const name = url.searchParams.get('name') ?? `Player${nextPlayerId}`;

  if (!code) {
    sendError(socket, 'BAD_REQUEST', 'Missing room code');
    socket.close();
    return;
  }

  const room = rooms.getRoom(code);
  if (!room) {
    sendError(socket, 'ROOM_NOT_FOUND', `Room ${code} does not exist`);
    socket.close();
    return;
  }

  const playerId = `p${nextPlayerId++}`;
  const conn = new Connection(playerId, name, socket);
  const result = room.addConnection(conn);
  if (!result.success) {
    sendError(socket, result.reason, `Cannot join room ${code}`);
    socket.close();
    return;
  }

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = decode<ClientMessage>(raw.toString());
    } catch {
      sendError(socket, 'BAD_REQUEST', 'Invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'input':
        room.ingestInput(playerId, msg.input);
        break;
      case 'ping':
        conn.send({ type: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
        break;
      case 'addBot':
        room.addBot();
        break;
      case 'hello':
        // We already used the query string; an explicit hello is ignored for now.
        break;
      default:
        sendError(socket, 'BAD_REQUEST', 'Unknown message type');
    }
  });

  socket.on('close', () => {
    conn.alive = false;
    room.removeConnection(playerId);
  });

  socket.on('error', () => {
    conn.alive = false;
    room.removeConnection(playerId);
  });
}
