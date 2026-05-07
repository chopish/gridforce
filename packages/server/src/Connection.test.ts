import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlayerInput } from '@gridforce/shared';
import { Connection } from './Connection.js';

// Stub WebSocket: only readyState/send/close are accessed in tests.
class StubSocket {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    /* noop */
  }
}

function input(tick: number): PlayerInput {
  return { tick, mx: 1, my: 0, dash: false };
}

test('consumeNextInput applies inputs in order, one per call', () => {
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput(input(1));
  conn.bufferInput(input(2));
  conn.bufferInput(input(3));

  const a = conn.consumeNextInput();
  const b = conn.consumeNextInput();
  const c = conn.consumeNextInput();
  const d = conn.consumeNextInput();

  assert.equal(a?.tick, 1);
  assert.equal(b?.tick, 2);
  assert.equal(c?.tick, 3);
  assert.equal(d, null);
  assert.equal(conn.lastAppliedInputTick, 3);
});

test('consumeNextInput handles out-of-order arrivals', () => {
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput(input(3));
  conn.bufferInput(input(1));
  conn.bufferInput(input(2));

  assert.equal(conn.consumeNextInput()?.tick, 1);
  assert.equal(conn.consumeNextInput()?.tick, 2);
  assert.equal(conn.consumeNextInput()?.tick, 3);
});

test('consumeNextInput skips inputs older than lastApplied', () => {
  // Simulates a late-arriving duplicate input
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput(input(1));
  conn.consumeNextInput();
  conn.bufferInput(input(1)); // late duplicate
  assert.equal(conn.consumeNextInput(), null);
});

test('consumeNextInput returns null on empty buffer', () => {
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  assert.equal(conn.consumeNextInput(), null);
});

test('regression: no inputs are silently dropped between ticks', () => {
  // Pre-fix bug: sending inputs at ticks 5, 6, 7 then calling once would
  // apply only 7 and drop 5/6, causing client/server divergence.
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput(input(5));
  conn.bufferInput(input(6));
  conn.bufferInput(input(7));

  const applied: number[] = [];
  let next = conn.consumeNextInput();
  while (next) {
    applied.push(next.tick);
    next = conn.consumeNextInput();
  }
  assert.deepEqual(applied, [5, 6, 7]);
});
