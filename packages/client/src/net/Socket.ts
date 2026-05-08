import {
  HelloMsg,
  INPUT_REDUNDANCY,
  InputMsg,
  MessageType,
  NetSim,
  NETSIM_PROFILES,
  PingMsg,
  RTT_OUTLIER_MS,
  SCHEMA_VERSION,
  SetLobbySettingsMsg,
  SetNpcCountMsg,
  SetReadyMsg,
  StartGameMsg,
  decodeMessage,
  type DecodedMessage,
  type NetSimProfile,
  type PlayerInput,
} from '@gridforce/shared';

import { SERVER_WS } from '../config.js';
import type { Channel, Transport, TransportKind } from './transport/Transport.js';
import { WebSocketTransport } from './transport/WebSocketTransport.js';

export type MessageListener = (m: DecodedMessage) => void;

export interface SocketStatus {
  state: 'connecting' | 'open' | 'closed' | 'error';
  rttMs: number;
  serverTimeOffsetMs: number; // EWMA of (serverTime - clientTime - owDelay)
  lastSimProfileName: string;
  // Set when Welcome lands. Used by the LobbyOverlay to authenticate
  // host-gated HTTP calls (invite creation).
  sessionKey: string;
  // Which transport is currently carrying the data plane (snapshots/inputs).
  // 'websocket' until WebRTC negotiates and a DataChannel is open.
  dataTransport: TransportKind;
}

const PING_INTERVAL_MS = 1000;
const RTT_EWMA_ALPHA = 0.2;

// Session-layer wrapper around a Transport. Handles handshake, pings,
// the redundancy window, NetSim dev simulation, and decode dispatch.
// The actual byte delivery is a Transport (WebSocket today, WebRTC and
// WebTransport in upcoming phases).
export class Socket {
  private transport: Transport | null = null;
  private listeners = new Set<MessageListener>();
  private closeListeners = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private nextNonce = 1;
  private pendingPings = new Map<number, number>(); // nonce -> clientTimeMs
  private rttMs = 0;
  private serverTimeOffsetMs = 0;
  private outSim: NetSim | null = null;
  private inSim: NetSim | null = null;
  private simName = 'off';
  private state: SocketStatus['state'] = 'closed';
  private name = '';
  private roomCode = '';
  private accessKey = '';
  private sessionKey = '';
  private outboxBeforeOpen: Array<{ bytes: Uint8Array; channel: Channel }> = [];
  // Sliding window of the last INPUT_REDUNDANCY inputs we've sent. Each
  // sendInput appends, trims to capacity, and re-sends the whole window
  // — a single dropped packet doesn't lose an input as long as the next
  // one gets through. Server dedupes via tick.
  private recentInputs: PlayerInput[] = [];

  connect(opts: { roomCode: string; name: string; accessKey?: string }): void {
    this.roomCode = opts.roomCode;
    this.name = opts.name;
    this.accessKey = opts.accessKey ?? '';
    this.state = 'connecting';
    this.openTransport();
  }

  private openTransport(): void {
    const t = new WebSocketTransport(SERVER_WS);
    this.transport = t;
    t.onOpen(() => {
      this.state = 'open';
      // Hello bypasses NetSim — handshake is reliable. NetSim simulates
      // in-game gameplay traffic only.
      t.send(
        HelloMsg.encode({
          schemaVersion: SCHEMA_VERSION,
          roomCode: this.roomCode,
          name: this.name,
          accessKey: this.accessKey,
        }),
        'reliable',
      );
      // Flush anything queued before open.
      for (const q of this.outboxBeforeOpen) this.send(q.bytes, q.channel);
      this.outboxBeforeOpen = [];
      this.startPings();
    });
    t.onMessage((bytes) => this.deliverIncoming(bytes));
    t.onClose(() => {
      this.state = 'closed';
      this.stopPings();
      for (const cb of this.closeListeners) {
        try {
          cb();
        } catch (err) {
          console.warn('[socket] close listener threw:', err);
        }
      }
    });
  }

  // Public API ---------------------------------------------------------------

  addListener(l: MessageListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  // Inputs are loss-tolerant (redundancy window covers the gap) and
  // strictly newer — perfect for the unreliable channel once available.
  sendInput(input: PlayerInput): void {
    this.recentInputs.push(input);
    if (this.recentInputs.length > INPUT_REDUNDANCY) this.recentInputs.shift();
    this.send(InputMsg.encode(this.recentInputs), 'unreliable');
  }

  sendSetReady(ready: boolean): void {
    this.send(SetReadyMsg.encode({ ready }), 'reliable');
  }

  sendStartGame(): void {
    this.send(StartGameMsg.encode({}), 'reliable');
  }

  sendLobbySettings(levelId: string, difficulty: number): void {
    this.send(SetLobbySettingsMsg.encode({ levelId, difficulty }), 'reliable');
  }

  sendSetNpcCount(count: number): void {
    this.send(SetNpcCountMsg.encode({ count }), 'reliable');
  }

  // Send any pre-encoded message (e.g. AddBot). Defaults to reliable —
  // callers that know better should use a dedicated method.
  sendRaw(bytes: Uint8Array): void {
    this.send(bytes, 'reliable');
  }

  setNetSimProfile(name: string, profile: NetSimProfile): void {
    this.simName = name;
    if (profile.owDelayMs === 0 && profile.jitterMs === 0 && profile.lossPct === 0) {
      this.outSim = null;
      this.inSim = null;
      return;
    }
    this.outSim = new NetSim(profile);
    this.inSim = new NetSim(profile);
  }

  cycleNetSimProfile(): string {
    const names = Object.keys(NETSIM_PROFILES);
    const i = names.indexOf(this.simName);
    const next = names[(i + 1) % names.length]!;
    this.setNetSimProfile(next, NETSIM_PROFILES[next]!);
    return next;
  }

  status(): SocketStatus {
    return {
      state: this.state,
      rttMs: this.rttMs,
      serverTimeOffsetMs: this.serverTimeOffsetMs,
      lastSimProfileName: this.simName,
      sessionKey: this.sessionKey,
      dataTransport: this.transport?.kind ?? 'websocket',
    };
  }

  // Drop pending pings + reset RTT/offset estimates. Called on tab visibility
  // restore so a ping sent before backgrounding doesn't return a multi-second
  // pong that gets folded into the EWMA (RTT_OUTLIER_MS in dispatch handles
  // the EWMA case; clearing pendingPings makes that drop explicit and lets
  // the next clean ping/pong re-establish the baseline immediately).
  resetRttForVisibilityRestore(): void {
    this.pendingPings.clear();
    this.rttMs = 0;
    this.serverTimeOffsetMs = 0;
    // The redundancy window holds inputs from before we backgrounded; their
    // ticks are stale relative to the resync target, and re-sending them on
    // resume would only invite the server to discard a flood of acks. Clear.
    this.recentInputs = [];
  }

  close(): void {
    this.stopPings();
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    this.state = 'closed';
  }

  // Internal -----------------------------------------------------------------

  private send(bytes: Uint8Array, channel: Channel): void {
    if (this.state !== 'open' || !this.transport) {
      this.outboxBeforeOpen.push({ bytes, channel });
      return;
    }
    if (this.outSim) {
      this.outSim.passThrough(bytes, (b) => this.transport!.send(b, channel));
    } else {
      this.transport.send(bytes, channel);
    }
  }

  private deliverIncoming(bytes: Uint8Array): void {
    // Welcome / Error bypass NetSim. Tag is the first byte of the LE u16 header.
    const isHandshake =
      bytes.byteLength >= 2 &&
      (bytes[0] === MessageType.Welcome || bytes[0] === MessageType.Error);
    if (this.inSim && !isHandshake) {
      this.inSim.passThrough(bytes, (b) => this.dispatch(b));
    } else {
      this.dispatch(bytes);
    }
  }

  private dispatch(bytes: Uint8Array): void {
    let decoded: DecodedMessage;
    try {
      decoded = decodeMessage(bytes);
    } catch (err) {
      console.warn('[socket] decode error:', err);
      return;
    }
    if (decoded.type === MessageType.Welcome) {
      this.sessionKey = decoded.payload.sessionKey;
    }
    if (decoded.type === MessageType.Pong) {
      const sent = this.pendingPings.get(decoded.payload.nonce);
      if (sent !== undefined) {
        this.pendingPings.delete(decoded.payload.nonce);
        const rtt = performance.now() - sent;
        // Skip outlier samples — typically a pong that arrives seconds late
        // because the tab was backgrounded. Folding it into the EWMA poisons
        // the adaptive lead and the RTT readout for many seconds.
        if (rtt < RTT_OUTLIER_MS) {
          this.rttMs =
            this.rttMs === 0 ? rtt : this.rttMs * (1 - RTT_EWMA_ALPHA) + rtt * RTT_EWMA_ALPHA;
          const owLatency = this.rttMs / 2;
          const offset = decoded.payload.serverTimeMs - performance.now() - owLatency;
          this.serverTimeOffsetMs =
            this.serverTimeOffsetMs === 0
              ? offset
              : this.serverTimeOffsetMs * (1 - RTT_EWMA_ALPHA) + offset * RTT_EWMA_ALPHA;
        }
      }
    }
    for (const l of this.listeners) l(decoded);
  }

  private startPings(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const nonce = this.nextNonce++;
      const clientTimeMs = performance.now();
      this.pendingPings.set(nonce, clientTimeMs);
      // Drop very old pending pings (lost packets) so the map doesn't grow.
      if (this.pendingPings.size > 16) {
        let oldestNonce = Number.POSITIVE_INFINITY;
        for (const k of this.pendingPings.keys()) if (k < oldestNonce) oldestNonce = k;
        if (Number.isFinite(oldestNonce)) this.pendingPings.delete(oldestNonce);
      }
      // Pings are loss-tolerant; the next one will go out a second later.
      this.send(PingMsg.encode({ nonce, clientTimeMs }), 'unreliable');
    }, PING_INTERVAL_MS);
  }

  private stopPings(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
