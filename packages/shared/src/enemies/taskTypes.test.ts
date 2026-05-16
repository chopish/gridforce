import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskKind, type Task } from './taskTypes.js';

test('TaskKind has 7 v1 vocabulary values', () => {
  assert.equal(TaskKind.SEEK_PLAYER, 'SEEK_PLAYER');
  assert.equal(TaskKind.ATTACK_PLAYER, 'ATTACK_PLAYER');
  assert.equal(TaskKind.SEEK_TILE, 'SEEK_TILE');
  assert.equal(TaskKind.ATTACK_TILE, 'ATTACK_TILE');
  assert.equal(TaskKind.SEARCH, 'SEARCH');
  assert.equal(TaskKind.INVESTIGATE, 'INVESTIGATE');
  assert.equal(TaskKind.IDLE, 'IDLE');
});

test('Task discriminated union narrows by kind', () => {
  const t: Task = { kind: TaskKind.SEEK_PLAYER, targetX: 10, targetY: 20 };
  if (t.kind === TaskKind.SEEK_PLAYER) {
    // TypeScript should accept these accesses; the assertion is the value.
    assert.equal(t.targetX, 10);
    assert.equal(t.targetY, 20);
  }
});

test('Task variants are constructible with correct payloads', () => {
  const tasks: Task[] = [
    { kind: TaskKind.SEEK_PLAYER,   targetX: 1, targetY: 2 },
    { kind: TaskKind.ATTACK_PLAYER, targetPlayerId: 7 },
    { kind: TaskKind.SEEK_TILE,     targetCx: 3, targetCy: 4 },
    { kind: TaskKind.ATTACK_TILE,   targetCx: 5, targetCy: 6 },
    { kind: TaskKind.SEARCH,        wanderTargetX: 10, wanderTargetY: 20 },
    { kind: TaskKind.INVESTIGATE,   targetX: 30, targetY: 40 },
    { kind: TaskKind.IDLE },
  ];
  assert.equal(tasks.length, Object.keys(TaskKind).length);
});
