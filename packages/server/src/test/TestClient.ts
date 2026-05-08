import { performance } from 'node:perf_hooks';

import { WebSocket } from 'ws';

import {
  HelloMsg,
  INPUT_LEAD_TICKS,
  INPUT_REDUNDANCY,
  InputMsg,
  MAX_REPLAY_INPUTS,
  MessageType,
  NetSim,
  SCHEMA_VERSION,
  SERVER_TICK_DT_S,
  decodeMessage,
  newPlayerState,
  stepPlayer,
  type DecodedMessage,
  type GridDef,
  type NetSimProfile,
  type PlayerId,
  type PlayerInput,
  type PlayerState,
} from '@gridforce/shared';

// In-process headless client for integration tests. Connects to a running
// server via real WebSocket, runs a tiny prediction loop, and tracks
// divergence + bandwidth so the test can assert on them.
//
// This is deliberately a smaller surface than the browser client (no UI, no
// rendering, no remote interpolation): the test only needs to ensure the
// netcode contract holds, not exercise PixiJS.
export interface TestClientStats {
  bytesReceived: number;
  snapshotsReceived: number;
  maxLocalDivergencePx: number;
  hardSnaps: number;
  finalLocalPosition: { x: number; y: number };
}

export interface TestClientOptions {
  url: string;
  roomCode: string;
  name: string;
  accessKey?: string;
  profile?: NetSimProfile;
  // What input pattern this client drives. Default: walks in a slow circle.
  drive?: (tick: number) => { mx: number; my: number; dash: boolean };
}

export class TestClient {
  private ws: WebSocket | null = null;
  private localId: PlayerId = -1;
  private grid: GridDef | null = null;
  private predictedTick = 0;
  private serverTick = 0;
  private localState: PlayerState | null = null;
  private pending: PlayerInput[] = [];
  private recentInputs: PlayerInput[] = [];
  private outSim: NetSim | null = null;
  private inSim: NetSim | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private welcomeWaiters: ((ok: boolean) => void)[] = [];
  // Captured from Welcome. Tests use this to authenticate host-gated
  // HTTP calls (invite creation).
  sessionKey = '';
  private stats: TestClientStats = {
    bytesReceived: 0,
    snapshotsReceived: 0,
    maxLocalDivergencePx: 0,
    hardSnaps: 0,
    finalLocalPosition: { x: 0, y: 0 },
  };

  constructor(private readonly opts: TestClientOptions) {
    if (opts.profile) {
      this.outSim = new NetSim(opts.profile);
      this.inSim = new NetSim(opts.profile);
    }
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => {
      // Hello bypasses NetSim — handshake must be reliable. The simulator
      // models in-game packet loss for inputs/snapshots, not bootstrap.
      const hello = HelloMsg.encode({
        schemaVersion: SCHEMA_VERSION,
        roomCode: this.opts.roomCode,
        name: this.opts.name,
        accessKey: this.opts.accessKey ?? '',
      });
      try {
        ws.send(hello);
      } catch {
        // socket gone
      }
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let bytes: Uint8Array;
      if (data instanceof Buffer) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (Array.isArray(data)) {
        const total = data.reduce((n, b) => n + b.byteLength, 0);
        bytes = new Uint8Array(total);
        let o = 0;
        for (const b of data) {
          bytes.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), o);
          o += b.byteLength;
        }
      } else return;
      this.stats.bytesReceived += bytes.byteLength;
      this.deliverIncoming(bytes);
    });
    ws.on('close', () => {
      this.stop();
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('welcome timeout')), 5000);
      this.welcomeWaiters.push((ok) => {
        clearTimeout(t);
        ok ? resolve() : reject(new Error('welcome failed'));
      });
    });
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tickOnce(), 1000 / 30);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    if (this.localState) {
      this.stats.finalLocalPosition = { x: this.localState.x, y: this.localState.y };
    }
  }

  getStats(): TestClientStats {
    if (this.localState) {
      this.stats.finalLocalPosition = { x: this.localState.x, y: this.localState.y };
    }
    return { ...this.stats };
  }

  // Internals ---------------------------------------------------------------

  private deliverIncoming(bytes: Uint8Array): void {
    // Welcome (and any error during handshake) must bypass NetSim — the
    // simulator only models in-game gameplay traffic. Welcome's message-type
    // tag is the first byte of the header (little-endian u16).
    const isHandshake =
      bytes.byteLength >= 2 &&
      (bytes[0] === MessageType.Welcome || bytes[0] === MessageType.Error);
    if (this.inSim && !isHandshake) this.inSim.passThrough(bytes, (b) => this.handle(b));
    else this.handle(bytes);
  }

  private handle(bytes: Uint8Array): void {
    let m: DecodedMessage;
    try {
      m = decodeMessage(bytes);
    } catch (err) {
      console.warn('[testclient] decode error:', err);
      return;
    }
    switch (m.type) {
      case MessageType.Welcome: {
        this.localId = m.payload.yourPlayerId;
        this.grid = m.payload.grid;
        this.sessionKey = m.payload.sessionKey;
        // Match the browser client: predict ahead of server so inputs land
        // in the future at the server.
        this.predictedTick = m.payload.startTick + INPUT_LEAD_TICKS;
        this.serverTick = m.payload.startTick;
        const me = m.payload.players.find((p) => p.id === this.localId);
        this.localState = me ? { ...me } : newPlayerState(this.localId, 100, 100);
        for (const cb of this.welcomeWaiters) cb(true);
        this.welcomeWaiters = [];
        break;
      }
      case MessageType.Snapshot: {
        this.stats.snapshotsReceived++;
        this.serverTick = m.payload.tick;
        // Catch up if we've fallen below the safe lead (matches PredictedWorld).
        const MIN_SAFE_LEAD = 2;
        if (this.predictedTick < m.payload.tick + MIN_SAFE_LEAD) {
          this.predictedTick = m.payload.tick + INPUT_LEAD_TICKS;
          this.pending = [];
        }
        // Drop acked pending inputs.
        while (this.pending.length > 0 && this.pending[0]!.tick <= m.payload.ackInputTick) {
          this.pending.shift();
        }
        const me = m.payload.players.find((p) => p.id === this.localId);
        if (me && this.grid) {
          // Rebase: take server's view, replay unacked inputs.
          let rebased: PlayerState = { ...me };
          for (const inp of this.pending) {
            rebased = stepPlayer(rebased, inp, SERVER_TICK_DT_S, this.grid);
          }
          if (this.localState) {
            const dx = this.localState.x - rebased.x;
            const dy = this.localState.y - rebased.y;
            const d = Math.hypot(dx, dy);
            if (d > this.stats.maxLocalDivergencePx) this.stats.maxLocalDivergencePx = d;
            if (d > 30) this.stats.hardSnaps++;
          }
          this.localState = rebased;
        }
        break;
      }
      default:
        break;
    }
  }

  private tickOnce(): void {
    if (!this.grid || !this.localState) return;
    this.predictedTick++;
    const drive = this.opts.drive ?? defaultDrive;
    const d = drive(this.predictedTick);
    const input: PlayerInput = {
      tick: this.predictedTick,
      clientTimeMs: performance.now(),
      mx: d.mx,
      my: d.my,
      dash: d.dash,
    };
    this.localState = stepPlayer(this.localState, input, SERVER_TICK_DT_S, this.grid);
    this.pending.push(input);
    if (this.pending.length > MAX_REPLAY_INPUTS) this.pending.shift();
    // Mirror the production client's redundancy window so integration tests
    // exercise the realistic upstream pattern (last N inputs every frame).
    this.recentInputs.push(input);
    if (this.recentInputs.length > INPUT_REDUNDANCY) this.recentInputs.shift();
    this.sendBytes(InputMsg.encode(this.recentInputs));
  }

  private sendBytes(bytes: Uint8Array): void {
    const real = (b: Uint8Array): void => {
      try {
        this.ws?.send(b);
      } catch {
        // socket gone
      }
    };
    if (this.outSim) this.outSim.passThrough(bytes, real);
    else real(bytes);
  }
}

function defaultDrive(tick: number): { mx: number; my: number; dash: boolean } {
  // Slow circular orbit at ~6 second period (30Hz × 6 = 180 ticks).
  const theta = (tick / 180) * Math.PI * 2;
  return { mx: Math.cos(theta), my: Math.sin(theta), dash: false };
}
