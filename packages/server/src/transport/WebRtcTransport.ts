import type { DataChannel } from 'node-datachannel';

import type { Channel, Transport, TransportState } from './Transport.js';

// Server-side wrapper around a single libdatachannel DataChannel. Used
// as the unreliable data plane in a MultiTransport — control + reliable
// stay on the WebSocket.

export class WebRtcTransport implements Transport {
  readonly kind = 'webrtc' as const;
  private _state: TransportState;
  private msgHandlers = new Set<(bytes: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(private readonly dc: DataChannel) {
    this._state = dc.isOpen() ? 'open' : 'connecting';
    dc.onOpen(() => {
      this._state = 'open';
    });
    dc.onClosed(() => {
      if (this.closed) return;
      this.closed = true;
      this._state = 'closed';
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch {
          // close handler errors must not abort the listener loop
        }
      }
    });
    dc.onError((_err) => {
      this._state = 'error';
    });
    dc.onMessage((msg) => {
      if (this.closed) return;
      const bytes = toBytes(msg);
      if (!bytes) return;
      for (const h of this.msgHandlers) h(bytes);
    });
  }

  get state(): TransportState {
    return this._state;
  }

  send(bytes: Uint8Array, _channel: Channel): void {
    if (this.closed || this._state !== 'open') return;
    try {
      this.dc.sendMessageBinary(bytes);
    } catch {
      // channel torn down underneath us; close handler will follow
    }
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
      // already closed
    }
  }
}

function toBytes(msg: string | Buffer | ArrayBuffer): Uint8Array | null {
  if (typeof msg === 'string') return null; // we only send binary
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (msg instanceof Buffer) return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
  return null;
}
