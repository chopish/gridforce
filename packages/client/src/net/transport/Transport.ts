// Client-side mirror of the server's Transport interface. See
// packages/server/src/transport/Transport.ts for the larger explanation.
//
// On the client the Transport is what actually owns the WebSocket /
// WebRTC peer / WebTransport session. Socket sits above it as a
// session-layer object (handshake, ping/pong, ack bookkeeping, NetSim
// dev wrapper) and routes outbound messages onto the appropriate
// channel via send(bytes, 'reliable' | 'unreliable').

export type Channel = 'reliable' | 'unreliable';
export type TransportKind = 'websocket' | 'webrtc' | 'webtransport';
export type TransportState = 'connecting' | 'open' | 'closed' | 'error';

export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  send(bytes: Uint8Array, channel: Channel): void;
  onOpen(handler: () => void): () => void;
  onMessage(handler: (bytes: Uint8Array) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
}
