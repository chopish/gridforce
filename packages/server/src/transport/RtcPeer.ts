import { PeerConnection, type DataChannel, type IceServer, type RtcConfig } from 'node-datachannel';

import type { Transport } from './Transport.js';
import { WebRtcTransport } from './WebRtcTransport.js';

// Per-Connection libdatachannel PeerConnection wrapper. The control
// plane (WebSocket) drives signalling (RtcOffer/RtcAnswer/RtcIce); this
// class is the libdatachannel side of that conversation.
//
// One DataChannel: 'data', unordered + maxRetransmits=0 (UDP-style).
// Reliable + ordered traffic stays on the WebSocket; we don't need a
// second DC unless RTC ever has to carry control too.

export interface RtcPeerOptions {
  iceServers: (string | IceServer)[];
  // Optional UDP port range to pin libdatachannel to. Useful in
  // production where the GCP firewall opens a known range. If unset,
  // libdatachannel picks ephemeral ports.
  portRangeBegin?: number;
  portRangeEnd?: number;
  // Sent to libdatachannel as a peer name; appears in logs.
  name?: string;
}

// Callbacks fired during signalling. Server is the offerer — onLocalSdp
// fires once with the offer right after the data channel is created
// (libdatachannel auto-negotiates). onLocalIce trickles candidates as
// they're gathered.
export interface RtcPeerCallbacks {
  onLocalSdp: (sdp: string, type: 'offer' | 'answer') => void;
  onLocalIce: (candidate: string, mid: string) => void;
  onDataTransport: (transport: Transport) => void;
  onClose: () => void;
}

export class RtcPeer {
  private peer: PeerConnection;
  private dc: DataChannel;
  private closed = false;

  constructor(opts: RtcPeerOptions, cb: RtcPeerCallbacks) {
    const cfg: RtcConfig = { iceServers: opts.iceServers };
    if (opts.portRangeBegin !== undefined) cfg.portRangeBegin = opts.portRangeBegin;
    if (opts.portRangeEnd !== undefined) cfg.portRangeEnd = opts.portRangeEnd;
    this.peer = new PeerConnection(opts.name ?? 'gridforce-peer', cfg);

    this.peer.onLocalDescription((sdp, type) => {
      if (this.closed) return;
      if (type === 'offer' || type === 'answer') {
        cb.onLocalSdp(sdp, type);
      }
    });
    this.peer.onLocalCandidate((candidate, mid) => {
      if (this.closed) return;
      cb.onLocalIce(candidate, mid);
    });
    this.peer.onStateChange((state) => {
      if (state === 'closed' || state === 'failed' || state === 'disconnected') {
        this.dispose(cb);
      }
    });

    // Create the unreliable+unordered data channel. libdatachannel will
    // auto-generate the offer at this point (default behavior).
    this.dc = this.peer.createDataChannel('data', {
      unordered: true,
      maxRetransmits: 0,
    });
    const transport = new WebRtcTransport(this.dc);
    transport.onClose(() => {
      // DC close ≠ peer close; the peer state-change callback handles
      // the larger lifecycle. Don't double-fire onClose here.
    });
    cb.onDataTransport(transport);
  }

  setRemoteAnswer(sdp: string): void {
    if (this.closed) return;
    this.peer.setRemoteDescription(sdp, 'answer');
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    if (this.closed) return;
    try {
      this.peer.addRemoteCandidate(candidate, mid);
    } catch (err) {
      // libdatachannel throws on malformed/duplicate candidates; ignore
      // so a single bad candidate doesn't tear down the peer.
      console.warn('[rtc] addRemoteCandidate:', err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dc.close();
    } catch {
      // ignore
    }
    try {
      this.peer.close();
    } catch {
      // ignore
    }
  }

  private dispose(cb: RtcPeerCallbacks): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dc.close();
    } catch {
      // ignore
    }
    try {
      this.peer.close();
    } catch {
      // ignore
    }
    cb.onClose();
  }
}
