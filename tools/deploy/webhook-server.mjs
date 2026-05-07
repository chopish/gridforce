#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.WEBHOOK_PORT ?? 9000);
const SECRET = process.env.WEBHOOK_SECRET;
const BRANCH = process.env.DEPLOY_BRANCH ?? 'main';
const REPO_DIR = process.env.REPO_DIR ?? path.resolve(fileURLToPath(import.meta.url), '../../..');
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT ?? path.join(REPO_DIR, 'tools/deploy/deploy.sh');

if (!SECRET) {
  console.error('FATAL: WEBHOOK_SECRET not set');
  process.exit(1);
}

const log = (...args) => console.log(`[webhook ${new Date().toISOString()}]`, ...args);

let deployRunning = false;
let deployPending = false;

function runDeploy(reason) {
  if (deployRunning) {
    deployPending = true;
    log('deploy already running; queued follow-up');
    return;
  }
  deployRunning = true;
  log(`starting deploy: ${reason}`);
  const child = spawn('bash', [DEPLOY_SCRIPT], {
    cwd: REPO_DIR,
    env: { ...process.env, DEPLOY_BRANCH: BRANCH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('close', (code) => {
    deployRunning = false;
    log(`deploy finished with code ${code}`);
    if (deployPending) {
      deployPending = false;
      runDeploy('queued follow-up');
    }
  });
}

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deployRunning, deployPending }));
    return;
  }

  if (req.method !== 'POST' || pathname !== '/webhook') {
    log(`404 ${req.method} ${req.url}`);
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > 5 * 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const sig = req.headers['x-hub-signature-256'];
    const event = req.headers['x-github-event'];

    if (!verifySignature(raw, sig)) {
      log('signature mismatch');
      res.writeHead(401);
      res.end('bad signature');
      return;
    }

    if (event === 'ping') {
      log('ping received');
      res.writeHead(200);
      res.end('pong');
      return;
    }

    if (event !== 'push') {
      res.writeHead(204);
      res.end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }

    const ref = payload.ref ?? '';
    const expectedRef = `refs/heads/${BRANCH}`;
    if (ref !== expectedRef) {
      log(`ignoring push to ${ref} (waiting for ${expectedRef})`);
      res.writeHead(202);
      res.end('ignored: wrong branch');
      return;
    }

    const sha = (payload.after ?? '').slice(0, 7);
    const pusher = payload.pusher?.name ?? 'unknown';
    runDeploy(`push ${sha} by ${pusher}`);
    res.writeHead(202);
    res.end('deploy triggered');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT}, branch=${BRANCH}, repo=${REPO_DIR}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  });
}
