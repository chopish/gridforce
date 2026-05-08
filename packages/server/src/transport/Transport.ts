// Transport abstraction sitting under Connection. Lets us swap the
// delivery mechanism (WebSocket today, WebRTC DataChannel + WebTransport
// later) without rewriting Connection or the room broadcast paths.
//
// Two channels exposed:
//   reliable   — must arrive, in order. Handshake, lobby messages,
//                join/leave, errors. WebSocket guarantees both.
//   unreliable — newer supersedes older; loss is fine. Snapshots, inputs
//                (already redundant), pings. Over WebSocket this is the
//                same physical channel as reliable; over WebRTC it's an
//                unreliable+unordered DataChannel; over WebTransport it
//                is a datagram.
//
// When a message arrives, the transport doesn't tell the consumer which
// channel it came from — the wire format is the same, decode is the
// same. Downstream code just gets bytes.

export type Channel = 'reliable' | 'unreliable';
export type TransportKind = 'websocket' | 'webrtc' | 'webtransport';
export type TransportState = 'connecting' | 'open' | 'closed' | 'error';

export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  send(bytes: Uint8Array, channel: Channel): void;
  onMessage(handler: (bytes: Uint8Array) => void): () => void;
  onClose(handler: () => void): () => void;
  close(code?: number, reason?: string): void;
}
