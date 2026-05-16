import test from 'node:test';
import assert from 'node:assert/strict';
import { MITE_PROFILE } from './profiles.js';
import { TaskKind } from './taskTypes.js';

test('MITE_PROFILE has the expected v1 task library', () => {
  assert.deepEqual([...MITE_PROFILE.taskLibrary].sort(), [
    TaskKind.ATTACK_PLAYER,
    TaskKind.ATTACK_TILE,
    TaskKind.IDLE,
    TaskKind.INVESTIGATE,
    TaskKind.SEARCH,
    TaskKind.SEEK_PLAYER,
    TaskKind.SEEK_TILE,
  ].sort());
});

test('MITE_PROFILE.startTask is SEEK_PLAYER', () => {
  assert.equal(MITE_PROFILE.startTask, TaskKind.SEEK_PLAYER);
});

test('MITE_PROFILE.taskWeights has a positive entry for every library task', () => {
  for (const t of MITE_PROFILE.taskLibrary) {
    const w = MITE_PROFILE.taskWeights[t];
    assert.ok(w !== undefined && w > 0, `taskWeights[${t}] must be > 0; got ${w}`);
  }
});

test('MITE_PROFILE.windUpDurS fits in u8 wire quantization (<= 2.55 s)', () => {
  assert.ok(MITE_PROFILE.windUpDurS <= 2.55);
});

test('MITE_PROFILE.startTask is in the taskLibrary', () => {
  assert.ok(
    MITE_PROFILE.taskLibrary.includes(MITE_PROFILE.startTask),
    'startTask must be a member of taskLibrary',
  );
});
