import { createServer } from 'node:http';

import cors from 'cors';
import express from 'express';

import { RoomManager } from './RoomManager.js';
import { attachWsHandler } from './wsHandler.js';

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(cors());
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: manager.roomCount });
});

const httpServer = createServer(app);
const manager = new RoomManager();
manager.start();
attachWsHandler(httpServer, manager);

httpServer.listen(PORT, () => {
  console.log(`[gridforce] http+ws on :${PORT} (ws path /ws)`);
});

function shutdown(signal: string): void {
  console.log(`[gridforce] shutdown on ${signal}`);
  manager.stop();
  httpServer.close(() => process.exit(0));
  // Hard timeout — never let dangling connections block exit forever.
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
