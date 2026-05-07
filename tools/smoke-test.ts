// Two-client smoke test. Connects two simulated clients to a fresh room,
// each sends inputs, and verifies both receive snapshots that include both
// players. Designed to run against a server already started on :8080.

import WebSocket from 'ws';

const HTTP = process.env.HTTP_URL ?? 'http://localhost:8080';
const WS = process.env.WS_URL ?? 'ws://localhost:8080';

type AnyMsg = { type: string; [k: string]: unknown };

async function createRoom(): Promise<string> {
  const r = await fetch(`${HTTP}/api/rooms`, { method: 'POST' });
  if (!r.ok) throw new Error(`Failed to create room: ${r.status}`);
  const j = (await r.json()) as { code: string };
  return j.code;
}

interface Client {
  name: string;
  ws: WebSocket;
  playerId?: string;
  snapshots: AnyMsg[];
  welcomed: Promise<AnyMsg>;
  closed: Promise<void>;
}

function connect(code: string, name: string): Client {
  const ws = new WebSocket(`${WS}/ws?code=${code}&name=${name}`);
  const snapshots: AnyMsg[] = [];
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  const welcomed = new Promise<AnyMsg>((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AnyMsg;
      if (msg.type === 'welcome') {
        client.playerId = msg.playerId as string;
        resolve(msg);
      } else if (msg.type === 'snapshot') {
        snapshots.push(msg);
      } else if (msg.type === 'error') {
        reject(new Error(`${msg.code}: ${msg.message}`));
      }
    });
    ws.on('error', reject);
  });
  const client: Client = { name, ws, snapshots, welcomed, closed };
  return client;
}

function sendInput(c: Client, tick: number, mx: number, my: number, dash = false): void {
  c.ws.send(
    JSON.stringify({ type: 'input', input: { tick, mx, my, dash }, clientTime: Date.now() }),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log('[smoke] creating room…');
  const code = await createRoom();
  console.log(`[smoke] room ${code}`);

  console.log('[smoke] connecting two clients…');
  const a = connect(code, 'Alice');
  const b = connect(code, 'Bob');

  const wa = await a.welcomed;
  const wb = await b.welcomed;
  console.log(`[smoke] welcome A: id=${wa.playerId} tick=${(wa.snapshot as any).tick}`);
  console.log(`[smoke] welcome B: id=${wb.playerId} tick=${(wb.snapshot as any).tick}`);

  // Drive Alice right (+x) for ~30 ticks; Bob stays still
  let baseTick = (wa.snapshot as any).tick as number;
  for (let i = 1; i <= 30; i++) {
    sendInput(a, baseTick + i, 1, 0);
    sendInput(b, baseTick + i, 0, 0);
    await delay(33);
  }
  await delay(120);

  // Find latest snapshot each client received
  const aLatest = a.snapshots.at(-1);
  const bLatest = b.snapshots.at(-1);
  if (!aLatest || !bLatest) throw new Error('Missing snapshots');

  const aPlayers = (aLatest as any).players as Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    isBot: boolean;
  }>;
  const bPlayers = (bLatest as any).players as typeof aPlayers;

  if (aPlayers.length !== 2 || bPlayers.length !== 2) {
    throw new Error(`Expected 2 players in each snapshot, got A=${aPlayers.length} B=${bPlayers.length}`);
  }

  const aliceA = aPlayers.find((p) => p.id === a.playerId)!;
  const aliceFromB = bPlayers.find((p) => p.id === a.playerId)!;
  const bobFromB = bPlayers.find((p) => p.id === b.playerId)!;

  console.log(`[smoke] alice (from A) x=${aliceA.x.toFixed(1)} y=${aliceA.y.toFixed(1)}`);
  console.log(`[smoke] alice (from B) x=${aliceFromB.x.toFixed(1)} y=${aliceFromB.y.toFixed(1)}`);
  console.log(`[smoke] bob   (from B) x=${bobFromB.x.toFixed(1)} y=${bobFromB.y.toFixed(1)}`);

  if (Math.abs(aliceA.x - aliceFromB.x) > 0.1) {
    throw new Error('Alice position diverges between A and B snapshots');
  }
  if (aliceA.x <= 100) {
    throw new Error(`Expected Alice to have moved right; x=${aliceA.x}`);
  }

  // Add a bot via A's connection
  console.log('[smoke] adding bot via A…');
  a.ws.send(JSON.stringify({ type: 'addBot' }));
  await delay(150);

  const aLatest2 = a.snapshots.at(-1);
  const players2 = (aLatest2 as any).players as typeof aPlayers;
  const bot = players2.find((p) => p.isBot);
  if (!bot) throw new Error('Bot not present in latest snapshot');
  console.log(`[smoke] bot ${bot.id} (${bot.name}) at (${bot.x.toFixed(0)}, ${bot.y.toFixed(0)})`);

  // Verify ackInputTick is increasing
  const ackTicks = a.snapshots.map((s) => (s as any).ackInputTick as number).filter((n) => n >= 0);
  const lastAck = ackTicks.at(-1)!;
  if (lastAck < baseTick + 20) {
    throw new Error(`Expected lastAck >= ${baseTick + 20}, got ${lastAck}`);
  }
  console.log(`[smoke] last ackInputTick for A: ${lastAck}`);

  a.ws.close();
  b.ws.close();
  await Promise.all([a.closed, b.closed]);
  console.log('[smoke] OK ✓');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
