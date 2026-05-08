import type { Channel, Transport, TransportState } from './Transport.js';

// Browser-side WebSocket wrapped in the Transport interface. Both
// channels route through the same WS frame for now. NetSim wraps this
// at the Socket layer, not here.

export class WebSocketTransport implements Transport {
  readonly kind = 'websocket' as const;
  private _state: TransportState = 'connecting';
  private ws: WebSocket;
  private openHandlers = new Set<() => void>();
  private msgHandlers = new Set<(bytes: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();

  constructor(url: string) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this._state = 'open';
      for (const h of this.openHandlers) {
        try {
          h();
        } catch (err) {
          console.warn('[transport] open handler threw:', err);
        }
      }
    };
    ws.onmessage = (e: MessageEvent<ArrayBuffer | Blob | string>) => {
      const data = e.data;
      if (!(data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data);
      for (const h of this.msgHandlers) h(bytes);
    };
    ws.onclose = () => {
      this._state = 'closed';
      for (const h of this.closeHandlers) {
        try {
          h();
        } catch (err) {
          console.warn('[transport] close handler threw:', err);
        }
      }
    };
    ws.onerror = () => {
      this._state = 'error';
    };
  }

  get state(): TransportState {
    return this._state;
  }

  send(bytes: Uint8Array, _channel: Channel): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(bytes);
    } catch {
      // socket gone — close listener will follow up
    }
  }

  onOpen(handler: () => void): () => void {
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
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
