import {
  HelloMsg,
  INPUT_REDUNDANCY,
  InputMsg,
  MessageType,
  NetSim,
  NETSIM_PROFILES,
  PingMsg,
  RTT_OUTLIER_MS,
  RtcAnswerMsg,
  RtcIceMsg,
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
import { MultiTransport } from './transport/MultiTransport.js';
import type { Channel, TransportKind } from './transport/Transport.js';
import { WebRtcTransport } from './transport/WebRtcTransport.js';
import { WebSocketTransport } from './transport/WebSocketTransport.js';

// STUN servers for the browser RTCPeerConnection. Server has its own
// matching list in transport/rtcConfig.ts.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

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
// The actual byte delivery is a MultiTransport — WebSocket as the
// always-present control plane, WebRTC DataChannel as the optional
// data plane that attaches once SDP/ICE negotiation completes.
export class Socket {
  private transport: MultiTransport | null = null;
  private rtcPeer: RTCPeerConnection | null = null;
  private rtcDataChannel: RTCDataChannel | null = null;
  private listeners = new Set<MessageListener>();
  private closeListeners = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private nextNonce = 1;
  private pendingPings = new Map<number, number>(); // nonce -> clientTimeMs
  private rttMs = 0;
  private serverTimeOffsetMs = 0;
  // NetSim is split per (direction × transport) so impairment is
  // transport-aware. Reliable always uses WS (tcp-hol). Unreliable uses
  // RTC (udp) when the data channel is open, else WS (tcp-hol). Lets us
  // measure WebRTC's HOL-blocking advantage in the dev simulator.
  private outSimWs: NetSim | null = null;
  private outSimRtc: NetSim | null = null;
  private inSimWs: NetSim | null = null;
  private inSimRtc: NetSim | null = null;
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
    const ws = new WebSocketTransport(SERVER_WS);
    const mux = new MultiTransport(ws);
    this.transport = mux;
    mux.onOpen(() => {
      this.state = 'open';
      // Hello bypasses NetSim — handshake is reliable. NetSim simulates
      // in-game gameplay traffic only.
      mux.send(
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
    mux.onMessageWithSource((bytes, source) => this.deliverIncoming(bytes, source));
    mux.onClose(() => {
      this.state = 'closed';
      this.stopPings();
      this.teardownRtc();
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

  sendLobbySettings(runId: string, difficulty: number): void {
    this.send(SetLobbySettingsMsg.encode({ runId, difficulty }), 'reliable');
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
      this.outSimWs = null;
      this.outSimRtc = null;
      this.inSimWs = null;
      this.inSimRtc = null;
      return;
    }
    this.outSimWs = new NetSim(profile, 'tcp-hol');
    this.outSimRtc = new NetSim(profile, 'udp');
    this.inSimWs = new NetSim(profile, 'tcp-hol');
    this.inSimRtc = new NetSim(profile, 'udp');
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
    // Outbound NetSim mirrors the routing inside MultiTransport: unreliable
    // takes RTC when the data channel is open, otherwise falls back to WS.
    const usingRtc = channel === 'unreliable' && this.transport.kind === 'webrtc';
    const sim = usingRtc ? this.outSimRtc : this.outSimWs;
    if (sim) {
      sim.passThrough(bytes, (b) => this.transport!.send(b, channel));
    } else {
      this.transport.send(bytes, channel);
    }
  }

  private deliverIncoming(bytes: Uint8Array, source: TransportKind): void {
    // Welcome / Error bypass NetSim. Tag is the first byte of the LE u16 header.
    const isHandshake =
      bytes.byteLength >= 2 && (bytes[0] === MessageType.Welcome || bytes[0] === MessageType.Error);
    const sim = source === 'webrtc' ? this.inSimRtc : this.inSimWs;
    if (sim && !isHandshake) {
      sim.passThrough(bytes, (b) => this.dispatch(b));
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
    if (decoded.type === MessageType.RtcOffer) {
      this.handleRtcOffer(decoded.payload.sdp).catch((err) => {
        console.warn('[rtc] offer handling failed:', err);
        this.teardownRtc();
      });
      // Don't propagate signalling messages to game listeners.
      return;
    }
    if (decoded.type === MessageType.RtcIce) {
      this.handleRemoteIce(decoded.payload.candidate, decoded.payload.mid).catch((err) => {
        console.warn('[rtc] addIceCandidate failed:', err);
      });
      return;
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

  // --- WebRTC -----------------------------------------------------------

  private async handleRtcOffer(sdp: string): Promise<void> {
    if (!this.transport) return;
    if (typeof RTCPeerConnection === 'undefined') {
      // Browser without WebRTC support (vanishingly rare). Stay on WS.
      return;
    }
    this.teardownRtc();

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.rtcPeer = pc;

    pc.onicecandidate = (e) => {
      if (!e.candidate) return; // null = end-of-gathering
      // sdpMid is the media-stream id; libdatachannel uses '0' for the
      // sole DC. Fall back to '0' if the browser elides it.
      const mid = e.candidate.sdpMid ?? '0';
      const candidate = e.candidate.candidate;
      if (!candidate) return;
      // Signalling rides reliable on the control transport (WS).
      this.transport!.send(RtcIceMsg.encode({ candidate, mid }), 'reliable');
    };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      if (dc.label !== 'data') return; // only one channel today
      this.rtcDataChannel = dc;
      const t = new WebRtcTransport(dc);
      t.onOpen(() => {
        // Once the DC is up, snapshots/inputs will route through it via
        // MultiTransport.send routing. Nothing else to do.
      });
      this.transport!.attachDataTransport(t);
    };
    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'closed'
      ) {
        this.teardownRtc();
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (!answer.sdp) return;
    this.transport.send(RtcAnswerMsg.encode({ sdp: answer.sdp }), 'reliable');
  }

  private async handleRemoteIce(candidate: string, mid: string): Promise<void> {
    if (!this.rtcPeer) return;
    if (!candidate) return;
    try {
      await this.rtcPeer.addIceCandidate({ candidate, sdpMid: mid });
    } catch {
      // duplicate / late candidates are normal; addIceCandidate may
      // throw harmlessly. Caller will log if it matters.
    }
  }

  private teardownRtc(): void {
    if (this.rtcDataChannel) {
      try {
        this.rtcDataChannel.close();
      } catch {
        // ignore
      }
      this.rtcDataChannel = null;
    }
    if (this.rtcPeer) {
      try {
        this.rtcPeer.close();
      } catch {
        // ignore
      }
      this.rtcPeer = null;
    }
    this.transport?.detachDataTransport();
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
