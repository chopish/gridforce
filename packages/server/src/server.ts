import { createServer } from 'node:http';

import cors from 'cors';
import express from 'express';

import { SCHEMA_VERSION } from '@gridforce/shared';

import { AccessKeyStore } from './AccessKeyStore.js';
import { InviteStore } from './InviteStore.js';
import { RoomManager } from './RoomManager.js';
import { attachHttpRoutes } from './httpRoutes.js';
import { attachWsHandler } from './wsHandler.js';

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(cors());
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: manager.roomCount, schemaVersion: SCHEMA_VERSION });
});

const manager = new RoomManager();
const invites = new InviteStore();
const accessKeys = new AccessKeyStore();
manager.start();
invites.start();
accessKeys.start();

attachHttpRoutes(app, { manager, invites, accessKeys });

const httpServer = createServer(app);
attachWsHandler(httpServer, { manager, invites, accessKeys });

httpServer.listen(PORT, () => {
  console.log(`[gridforce] http+ws on :${PORT} (ws path /ws)`);
});

function shutdown(signal: string): void {
  console.log(`[gridforce] shutdown on ${signal}`);
  manager.stop();
  invites.stop();
  accessKeys.stop();
  httpServer.close(() => process.exit(0));
  // Hard timeout — never let dangling connections block exit forever.
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
