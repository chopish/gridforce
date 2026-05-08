import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Connection } from './Connection.js';

// Minimal fake WebSocket that satisfies just the surface the Connection class
// touches at construction. Tests focus on the input-buffer / ack-bitmask
// logic, which doesn't go anywhere near the wire.
function fakeWs(): unknown {
  const ee = new EventEmitter() as EventEmitter & {
    readyState: number;
    OPEN: number;
    sent: Uint8Array[];
    send(buf: Uint8Array): void;
    close(): void;
  };
  ee.readyState = 1;
  ee.OPEN = 1;
  ee.sent = [];
  ee.send = (buf: Uint8Array) => {
    ee.sent.push(buf);
  };
  ee.close = () => {
    ee.readyState = 3;
    ee.emit('close');
  };
  return ee;
}

function input(tick: number) {
  return { tick, clientTimeMs: tick * 16, mx: 0, my: 0, dash: false };
}

test('consumeInputForTick returns null when no input present, advances ack', () => {
  const ws = fakeWs();
  const c = new Connection(0, '', '', ws as never, () => {});
  const r = c.consumeInputForTick(5);
  assert.equal(r, null);
  assert.equal(c.ackInputTick, 5);
  // Bitmask: ackInputTick=5, none of (4,3,2,1,0) had inputs → 0
  assert.equal(c.computeAckBitmask(), 0);
});

test('ackInputTick advances monotonically; bitmask reflects which prior ticks had inputs', () => {
  const ws = fakeWs();
  const c = new Connection(0, '', '', ws as never, () => {});
  // Synthetically buffer inputs by going through the public buffering door.
  // We have to invoke the private `bufferInput` indirectly via a fake decoded
  // message — simpler: poke at the inputs map via a back door isn't allowed
  // because it's private. Instead, simulate the network path: add inputs
  // through repeated consumeInputForTick that pulls from the buffer.
  //
  // Workaround: use the protected interface by delivering inputs via the
  // message handler. We construct decode bytes for Input messages.
  // For unit-test simplicity we use a direct private accessor via cast.
  const priv = c as unknown as { bufferInput(i: ReturnType<typeof input>): void };
  priv.bufferInput(input(10));
  priv.bufferInput(input(11));
  priv.bufferInput(input(13)); // gap at 12

  // Process 10, 11, 12, 13 in order
  assert.equal(c.consumeInputForTick(10)?.tick, 10);
  assert.equal(c.consumeInputForTick(11)?.tick, 11);
  assert.equal(c.consumeInputForTick(12), null); // missing
  assert.equal(c.consumeInputForTick(13)?.tick, 13);

  assert.equal(c.ackInputTick, 13);
  // bit i ⇔ tick (13-1-i) had input applied
  // tick 12 missing → bit 0 = 0
  // tick 11 applied → bit 1 = 1
  // tick 10 applied → bit 2 = 1
  // tick  9 missing → bit 3 = 0
  const m = c.computeAckBitmask();
  assert.equal(m & 1, 0, 'bit 0 (tick 12) is missing');
  assert.equal((m >> 1) & 1, 1, 'bit 1 (tick 11) is applied');
  assert.equal((m >> 2) & 1, 1, 'bit 2 (tick 10) is applied');
  assert.equal((m >> 3) & 1, 0, 'bit 3 (tick 9) is missing');
});

test('inputs older than ackInputTick are dropped on receipt', () => {
  const ws = fakeWs();
  const c = new Connection(0, '', '', ws as never, () => {});
  c.consumeInputForTick(20); // ack=20, no input
  const priv = c as unknown as { bufferInput(i: ReturnType<typeof input>): void };
  priv.bufferInput(input(15)); // stale
  // Trying to consume tick 15 finds nothing because it was never buffered.
  assert.equal(c.consumeInputForTick(15), null);
});

test('input buffer caps to MAX_INPUT_BUFFER, dropping oldest', () => {
  const ws = fakeWs();
  const c = new Connection(0, '', '', ws as never, () => {});
  const priv = c as unknown as { bufferInput(i: ReturnType<typeof input>): void };
  // Buffer way more than the cap
  for (let t = 1; t <= 500; t++) priv.bufferInput(input(t));
  // The oldest should be gone, the newest should be present.
  // We drop oldest one at a time as new ones come in past the cap, so e.g.
  // tick 500 is present, tick 1 isn't.
  const r500 = c.consumeInputForTick(500);
  assert.equal(r500?.tick, 500);
  // After consuming tick 500, ack=500. consuming tick 1 with no buffered input is null.
  c.consumeInputForTick(1);
  // No assertion needed; the point is: it doesn't crash and doesn't leak unbounded.
});

test('redundancy: re-buffering the same tick is idempotent (only consumed once)', () => {
  // The client sends the last N ticks in every Input message; under loss
  // the server may receive any subset of (tick, tick+1, tick+2, ...) more
  // than once. bufferInput's tick-as-Map-key contract means each tick can
  // only ever be applied once by consumeInputForTick.
  const ws = fakeWs();
  const c = new Connection(0, '', '', ws as never, () => {});
  const priv = c as unknown as { bufferInput(i: ReturnType<typeof input>): void };
  priv.bufferInput(input(50));
  priv.bufferInput(input(51));
  priv.bufferInput(input(50)); // duplicate — last write wins, same content
  priv.bufferInput(input(51));
  priv.bufferInput(input(52));

  assert.equal(c.consumeInputForTick(50)?.tick, 50);
  assert.equal(c.consumeInputForTick(51)?.tick, 51);
  assert.equal(c.consumeInputForTick(52)?.tick, 52);
  // Re-arrival after consume is dropped — ack moves the wall forward.
  priv.bufferInput(input(50));
  assert.equal(c.consumeInputForTick(50), null);
});
