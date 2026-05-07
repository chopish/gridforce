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

test('consumeInputForTick applies the newest input intended for the target tick', () => {
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput(input(1));
  conn.bufferInput(input(2));
  conn.bufferInput(input(3));

  const applied = conn.consumeInputForTick(3);

  assert.equal(applied.tick, 3);
  assert.equal(conn.lastAppliedInputTick, 3);
  assert.equal(conn.bufferedInputCount(), 0);
});

test('consumeInputForTick waits for future inputs', () => {
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput(input(3));
  conn.bufferInput(input(1));
  conn.bufferInput(input(2));

  assert.equal(conn.consumeInputForTick(1).tick, 1);
  assert.equal(conn.consumeInputForTick(2).tick, 2);
  assert.equal(conn.consumeInputForTick(3).tick, 3);
});

test('consumeInputForTick skips duplicate inputs older than lastApplied', () => {
  // Simulates a late-arriving duplicate input
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput(input(1));
  conn.consumeInputForTick(1);
  conn.bufferInput(input(1)); // late duplicate
  assert.equal(conn.bufferedInputCount(), 0);
  assert.equal(conn.consumeInputForTick(2).tick, 2);
  assert.equal(conn.lastAppliedInputTick, 1);
});

test('consumeInputForTick returns zero input before any input arrives', () => {
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  assert.deepEqual(conn.consumeInputForTick(5), { tick: 5, mx: 0, my: 0, dash: false });
  assert.equal(conn.lastAppliedInputTick, -1);
});

test('consumeInputForTick holds the last movement input without relatching dash', () => {
  const conn = new Connection('p1', 'A', new StubSocket() as unknown as never);
  conn.bufferInput({ tick: 1, mx: 1, my: 0, dash: true });

  assert.deepEqual(conn.consumeInputForTick(1), { tick: 1, mx: 1, my: 0, dash: true });
  assert.deepEqual(conn.consumeInputForTick(2), { tick: 2, mx: 1, my: 0, dash: false });
  assert.equal(conn.lastAppliedInputTick, 1);
});
