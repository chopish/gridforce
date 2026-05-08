import type { Channel, Transport, TransportKind, TransportState } from './Transport.js';

// Transport that owns one always-present "control" transport (WebSocket
// today) plus an optionally attached "data" transport (WebRTC DataChannel
// once it's negotiated).
//
// send(bytes, 'reliable')   → control
// send(bytes, 'unreliable') → data if open, else falls back to control
//
// Incoming messages from either underlying transport are forwarded up
// to the consumer's onMessage handler. close on the control transport
// closes the whole MultiTransport; close on the data transport just
// reverts to control-only without disturbing the application.

export class MultiTransport implements Transport {
  private msgHandlers = new Set<(bytes: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();
  private dataTransport: Transport | null = null;
  private dataMessageUnsub: (() => void) | null = null;
  private dataCloseUnsub: (() => void) | null = null;
  private closed = false;

  constructor(private readonly controlTransport: Transport) {
    controlTransport.onMessage((b) => {
      for (const h of this.msgHandlers) h(b);
    });
    controlTransport.onClose(() => {
      this.closed = true;
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch {
          // close handlers must not crash the listener loop
        }
      }
    });
  }

  // The kind reflects what's actually carrying the data plane right now —
  // useful for the HUD readout. Falls back to control's kind when data
  // isn't attached.
  get kind(): TransportKind {
    if (this.dataTransport && this.dataTransport.state === 'open') {
      return this.dataTransport.kind;
    }
    return this.controlTransport.kind;
  }

  get state(): TransportState {
    return this.controlTransport.state;
  }

  // Attach a data-plane transport. Once its state is 'open', unreliable
  // sends route through it; reliable always stays on control. If the
  // data transport closes (RTC ICE failure, peer leave), we silently
  // unhook and revert to control-only.
  attachDataTransport(t: Transport): void {
    if (this.closed) {
      t.close();
      return;
    }
    this.detachDataTransport();
    this.dataTransport = t;
    this.dataMessageUnsub = t.onMessage((b) => {
      for (const h of this.msgHandlers) h(b);
    });
    this.dataCloseUnsub = t.onClose(() => {
      // Don't fire our close handlers — control is still up.
      this.detachDataTransport();
    });
  }

  detachDataTransport(): void {
    if (!this.dataTransport) return;
    if (this.dataMessageUnsub) this.dataMessageUnsub();
    if (this.dataCloseUnsub) this.dataCloseUnsub();
    this.dataMessageUnsub = null;
    this.dataCloseUnsub = null;
    const t = this.dataTransport;
    this.dataTransport = null;
    try {
      t.close();
    } catch {
      // ignore
    }
  }

  send(bytes: Uint8Array, channel: Channel): void {
    if (this.closed) return;
    if (channel === 'unreliable' && this.dataTransport && this.dataTransport.state === 'open') {
      this.dataTransport.send(bytes, channel);
      return;
    }
    this.controlTransport.send(bytes, channel);
  }

  onMessage(handler: (bytes: Uint8Array) => void): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.detachDataTransport();
    this.controlTransport.close(code, reason);
  }
}
