import type { WebSocket } from 'ws';

import type { Channel, Transport, TransportState } from './Transport.js';

// Wraps a `ws`-library WebSocket in the Transport interface. Both
// channels route through the same WS frame — the hint is informational
// for now and will only matter once richer transports are in play.

export class WebSocketTransport implements Transport {
  readonly kind = 'websocket' as const;
  private _state: TransportState;
  private msgHandlers = new Set<(bytes: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(private readonly ws: WebSocket) {
    this._state = ws.readyState === ws.OPEN ? 'open' : 'connecting';

    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (this.closed) return;
      if (!isBinary) return;
      const bytes = toBytes(data);
      if (!bytes) return;
      for (const h of this.msgHandlers) h(bytes);
    });

    const fireClose = (): void => {
      if (this.closed) return;
      this.closed = true;
      this._state = 'closed';
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch {
          // close handlers must not crash the listener loop
        }
      }
    };
    ws.on('close', fireClose);
    ws.on('error', () => {
      this._state = 'error';
      fireClose();
    });
    ws.on('open', () => {
      this._state = 'open';
    });
  }

  get state(): TransportState {
    return this._state;
  }

  send(bytes: Uint8Array, _channel: Channel): void {
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(bytes, { binary: true });
    } catch {
      // socket gone — close listener will clean up
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

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this._state = 'closed';
    try {
      this.ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Buffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const total = (data as Buffer[]).reduce((n, b) => n + b.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of data as Buffer[]) {
      out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
      off += b.byteLength;
    }
    return out;
  }
  return null;
}
