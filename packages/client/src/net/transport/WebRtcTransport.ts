import type { Channel, Transport, TransportState } from './Transport.js';

// Client-side wrapper around a single RTCDataChannel. Receives messages
// (binary), forwards them up to the consumer; send routes binary into
// the channel. Channel hint is informational on the client side — we
// only have one DC.

export class WebRtcTransport implements Transport {
  readonly kind = 'webrtc' as const;
  private _state: TransportState;
  private msgHandlers = new Set<(bytes: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();
  private openHandlers = new Set<() => void>();
  private closed = false;

  constructor(private readonly dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    this._state =
      dc.readyState === 'open'
        ? 'open'
        : dc.readyState === 'closed' || dc.readyState === 'closing'
          ? 'closed'
          : 'connecting';
    dc.onopen = () => {
      this._state = 'open';
      for (const h of this.openHandlers) {
        try {
          h();
        } catch (err) {
          console.warn('[rtc] open handler threw:', err);
        }
      }
    };
    dc.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this._state = 'closed';
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch (err) {
          console.warn('[rtc] close handler threw:', err);
        }
      }
    };
    dc.onerror = () => {
      this._state = 'error';
    };
    dc.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (this.closed) return;
      const data = e.data;
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);
        for (const h of this.msgHandlers) h(bytes);
      }
      // text frames are ignored — we don't send any
    };
  }

  get state(): TransportState {
    return this._state;
  }

  send(bytes: Uint8Array, _channel: Channel): void {
    if (this.closed || this._state !== 'open') return;
    try {
      // RTCDataChannel.send accepts ArrayBuffer or ArrayBufferView. Slice
      // produces a fresh ArrayBuffer of just the relevant bytes — we
      // can't pass a Uint8Array directly because lib.dom typings reject
      // SharedArrayBuffer-backed views.
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.dc.send(ab as ArrayBuffer);
    } catch {
      // channel torn down; close handler will follow
    }
  }

  onOpen(handler: () => void): () => void {
    if (this._state === 'open') {
      // Already open — fire on next tick so caller can subscribe normally.
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

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this._state = 'closed';
    try {
      this.dc.close();
    } catch {
      // ignore
    }
  }
}
