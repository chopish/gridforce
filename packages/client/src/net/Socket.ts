import {
  decode,
  encode,
  type ClientMessage,
  type PlayerInput,
  type ServerMessage,
} from '@gridforce/shared';
import { SERVER_WS } from '../config.js';

type Handler = (msg: ServerMessage) => void;

export class GameSocket {
  private ws: WebSocket;
  private handlers = new Set<Handler>();
  private closeHandlers = new Set<() => void>();

  // Most recent measured RTT in ms (from ping/pong).
  rttMs = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(roomCode: string, name: string) {
    const url = `${SERVER_WS}/ws?code=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(name)}`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (ev) => {
      try {
        const msg = decode<ServerMessage>(ev.data);
        if (msg.type === 'pong') {
          this.rttMs = Date.now() - msg.clientTime;
          return;
        }
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore malformed
      }
    });
    this.ws.addEventListener('close', () => {
      this.stopPings();
      for (const h of this.closeHandlers) h();
    });
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const onOpen = () => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onErr);
        this.startPings();
        resolve();
      };
      const onErr = (e: Event) => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onErr);
        reject(e);
      };
      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onErr);
    });
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  sendInput(input: PlayerInput): void {
    this.send({ type: 'input', input, clientTime: Date.now() });
  }

  addBot(): void {
    this.send({ type: 'addBot' });
  }

  close(): void {
    this.stopPings();
    this.ws.close();
  }

  private send(msg: ClientMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encode(msg));
    } catch {
      /* socket dead */
    }
  }

  private startPings(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping', clientTime: Date.now() });
    }, 1000);
  }

  private stopPings(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
