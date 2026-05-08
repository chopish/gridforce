import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MultiTransport } from '../MultiTransport.js';
import type { Channel, Transport, TransportKind, TransportState } from '../Transport.js';

// FakeTransport: drives the Transport interface in tests without real I/O.
// Records send calls, exposes drivers for incoming messages and close.
class FakeTransport implements Transport {
  readonly kind: TransportKind;
  private _state: TransportState;
  readonly sent: Array<{ bytes: Uint8Array; channel: Channel }> = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private msgHandlers = new Set<(b: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();

  constructor(kind: TransportKind, initialState: TransportState = 'open') {
    this.kind = kind;
    this._state = initialState;
  }

  get state(): TransportState {
    return this._state;
  }
  setState(s: TransportState): void {
    this._state = s;
  }

  send(bytes: Uint8Array, channel: Channel): void {
    this.sent.push({ bytes, channel });
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
    this.closeCalls.push({ code, reason });
    this._state = 'closed';
    for (const h of this.closeHandlers) h();
  }

  // Drivers — call from tests to simulate the real transport firing.
  drive_message(bytes: Uint8Array): void {
    for (const h of this.msgHandlers) h(bytes);
  }
  drive_close(): void {
    this._state = 'closed';
    for (const h of this.closeHandlers) h();
  }

  // Listener counts — useful for asserting attach/detach didn't leak.
  get messageHandlerCount(): number {
    return this.msgHandlers.size;
  }
  get closeHandlerCount(): number {
    return this.closeHandlers.size;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('reliable always routes to control transport', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc');
  const mux = new MultiTransport(ws);
  mux.attachDataTransport(rtc);

  mux.send(new Uint8Array([0x42]), 'reliable');
  assert.equal(ws.sent.length, 1);
  assert.equal(rtc.sent.length, 0);
  assert.equal(ws.sent[0]!.channel, 'reliable');
});

test('unreliable routes to data transport when open', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc');
  const mux = new MultiTransport(ws);
  mux.attachDataTransport(rtc);

  mux.send(new Uint8Array([1]), 'unreliable');
  assert.equal(rtc.sent.length, 1);
  assert.equal(ws.sent.length, 0);
});

test('unreliable falls back to control when no data transport attached', () => {
  const ws = new FakeTransport('websocket');
  const mux = new MultiTransport(ws);

  mux.send(new Uint8Array([1]), 'unreliable');
  assert.equal(ws.sent.length, 1);
});

test('unreliable falls back to control while data transport is connecting', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc', 'connecting');
  const mux = new MultiTransport(ws);
  mux.attachDataTransport(rtc);

  // Data is attached but not yet 'open' → fall back.
  mux.send(new Uint8Array([1]), 'unreliable');
  assert.equal(ws.sent.length, 1);
  assert.equal(rtc.sent.length, 0);

  // Once open, switch over.
  rtc.setState('open');
  mux.send(new Uint8Array([2]), 'unreliable');
  assert.equal(ws.sent.length, 1);
  assert.equal(rtc.sent.length, 1);
});

test('kind reflects active data transport when open, control otherwise', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc', 'connecting');
  const mux = new MultiTransport(ws);

  assert.equal(mux.kind, 'websocket');
  mux.attachDataTransport(rtc);
  assert.equal(mux.kind, 'websocket', 'data is connecting, kind stays on control');
  rtc.setState('open');
  assert.equal(mux.kind, 'webrtc');
  rtc.setState('closed');
  assert.equal(mux.kind, 'websocket');
});

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------

test('onMessage fires for messages from both control and data', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc');
  const mux = new MultiTransport(ws);
  mux.attachDataTransport(rtc);

  const received: number[] = [];
  mux.onMessage((b) => received.push(b[0]!));

  ws.drive_message(new Uint8Array([1]));
  rtc.drive_message(new Uint8Array([2]));
  ws.drive_message(new Uint8Array([3]));

  assert.deepEqual(received, [1, 2, 3]);
});

test('onMessage unsubscribe stops further deliveries', () => {
  const ws = new FakeTransport('websocket');
  const mux = new MultiTransport(ws);

  const received: number[] = [];
  const off = mux.onMessage((b) => received.push(b[0]!));

  ws.drive_message(new Uint8Array([1]));
  off();
  ws.drive_message(new Uint8Array([2]));

  assert.deepEqual(received, [1]);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('detachDataTransport unhooks listeners and closes the data transport', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc');
  const mux = new MultiTransport(ws);
  mux.attachDataTransport(rtc);

  assert.equal(rtc.messageHandlerCount, 1);
  assert.equal(rtc.closeHandlerCount, 1);

  mux.detachDataTransport();

  assert.equal(rtc.messageHandlerCount, 0, 'detach removes message listener');
  assert.equal(rtc.closeHandlerCount, 0, 'detach removes close listener');
  assert.equal(rtc.closeCalls.length, 1, 'detach closes the data transport');
});

test('data transport closing on its own reverts to control without firing mux close', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc');
  const mux = new MultiTransport(ws);
  mux.attachDataTransport(rtc);

  let muxClosed = false;
  mux.onClose(() => {
    muxClosed = true;
  });

  rtc.drive_close();

  assert.equal(muxClosed, false, 'data-only close must not propagate up');
  // After data-channel close, unreliable should fall back to control.
  mux.send(new Uint8Array([7]), 'unreliable');
  assert.equal(ws.sent.length, 1);
});

test('reattaching data transport detaches the previous one first', () => {
  const ws = new FakeTransport('websocket');
  const rtc1 = new FakeTransport('webrtc');
  const rtc2 = new FakeTransport('webrtc');
  const mux = new MultiTransport(ws);

  mux.attachDataTransport(rtc1);
  assert.equal(rtc1.messageHandlerCount, 1);

  mux.attachDataTransport(rtc2);
  assert.equal(rtc1.messageHandlerCount, 0, 'previous data transport detached');
  assert.equal(rtc1.closeCalls.length, 1, 'previous data transport closed');
  assert.equal(rtc2.messageHandlerCount, 1, 'new data transport hooked');

  // Sends should now go to rtc2.
  mux.send(new Uint8Array([1]), 'unreliable');
  assert.equal(rtc2.sent.length, 1);
});

test('close on the mux closes both transports and fires close handlers', () => {
  const ws = new FakeTransport('websocket');
  const rtc = new FakeTransport('webrtc');
  const mux = new MultiTransport(ws);
  mux.attachDataTransport(rtc);

  let closed = 0;
  mux.onClose(() => {
    closed++;
  });

  mux.close(1001, 'goodbye');

  assert.equal(closed, 1);
  assert.equal(ws.closeCalls.length, 1);
  assert.equal(ws.closeCalls[0]!.code, 1001);
  assert.equal(rtc.closeCalls.length, 1);
});

test('control transport closing fires close handlers and stops sends', () => {
  const ws = new FakeTransport('websocket');
  const mux = new MultiTransport(ws);

  let closed = 0;
  mux.onClose(() => {
    closed++;
  });

  ws.drive_close();
  assert.equal(closed, 1);

  // Sends after close are silently dropped — never reach the closed transport.
  mux.send(new Uint8Array([1]), 'reliable');
  // Only the close call was recorded, no sends after.
  assert.equal(ws.sent.length, 0);
});

test('attachDataTransport on a closed mux closes the new transport immediately', () => {
  const ws = new FakeTransport('websocket');
  const mux = new MultiTransport(ws);
  ws.drive_close();

  const rtc = new FakeTransport('webrtc');
  mux.attachDataTransport(rtc);

  assert.equal(rtc.closeCalls.length, 1, 'new data transport closed because mux is already gone');
  assert.equal(rtc.messageHandlerCount, 0, 'no listeners attached');
});
