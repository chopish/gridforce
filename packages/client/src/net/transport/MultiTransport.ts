import type { Channel, Transport, TransportKind, TransportState } from './Transport.js';

// Client mirror of the server-side MultiTransport. WS is the always-
// present control transport; an RTC DataChannel transport may attach
// once negotiation completes. Unreliable sends prefer the data
// transport when open and fall back to control otherwise.

export class MultiTransport implements Transport {
  private msgHandlers = new Set<(bytes: Uint8Array) => void>();
  private msgSourceHandlers = new Set<(bytes: Uint8Array, source: TransportKind) => void>();
  private openHandlers = new Set<() => void>();
  private closeHandlers = new Set<() => void>();
  private dataTransport: Transport | null = null;
  private dataMessageUnsub: (() => void) | null = null;
  private dataCloseUnsub: (() => void) | null = null;
  private closed = false;

  constructor(private readonly controlTransport: Transport) {
    controlTransport.onOpen(() => {
      for (const h of this.openHandlers) {
        try {
          h();
        } catch (err) {
          console.warn('[transport] open handler threw:', err);
        }
      }
    });
    controlTransport.onMessage((b) => {
      for (const h of this.msgHandlers) h(b);
      for (const h of this.msgSourceHandlers) h(b, controlTransport.kind);
    });
    controlTransport.onClose(() => {
      this.closed = true;
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch (err) {
          console.warn('[transport] close handler threw:', err);
        }
      }
    });
  }

  get kind(): TransportKind {
    if (this.dataTransport && this.dataTransport.state === 'open') {
      return this.dataTransport.kind;
    }
    return this.controlTransport.kind;
  }

  get state(): TransportState {
    return this.controlTransport.state;
  }

  attachDataTransport(t: Transport): void {
    if (this.closed) {
      t.close();
      return;
    }
    this.detachDataTransport();
    this.dataTransport = t;
    this.dataMessageUnsub = t.onMessage((b) => {
      for (const h of this.msgHandlers) h(b);
      for (const h of this.msgSourceHandlers) h(b, t.kind);
    });
    this.dataCloseUnsub = t.onClose(() => {
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

  onOpen(handler: () => void): () => void {
    if (this.controlTransport.state === 'open') {
      // Microtask-defer so caller can finish subscribing before fire.
      void Promise.resolve().then(() => {
        if (!this.closed) handler();
      });
    }
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  onMessage(handler: (bytes: Uint8Array) => void): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  // Like onMessage, but the handler also receives the kind of the
  // underlying transport that delivered the bytes. Used by NetSim to
  // apply transport-aware impairment (TCP-HOL on WS, UDP on RTC).
  onMessageWithSource(handler: (bytes: Uint8Array, source: TransportKind) => void): () => void {
    this.msgSourceHandlers.add(handler);
    return () => this.msgSourceHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.detachDataTransport();
    this.controlTransport.close();
  }
}
