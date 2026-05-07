import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './RoomManager.js';
import { handleWsConnection } from './wsHandler.js';

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(cors());
app.use(express.json());

const rooms = new RoomManager();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, time: Date.now() });
});

app.post('/api/rooms', (_req, res) => {
  const code = rooms.createRoom();
  res.json({ code });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.getRoom(req.params.code.toUpperCase());
  if (!room) {
    res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    return;
  }
  res.json({
    code: room.code,
    players: room.getPlayerSummaries(),
    capacity: room.capacity,
  });
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket, req) => {
  handleWsConnection(socket, req, rooms);
});

httpServer.listen(PORT, () => {
  console.log(`[gridforce] server listening on :${PORT}`);
});
