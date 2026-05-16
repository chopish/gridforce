import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import {
  CrawlerAIState,
  CONDUCTION_THRESHOLD,
  L1_PANEL_MAX_HP,
  allocateTiles,
  indexOf,
  type TileBuffers,
} from '@gridforce/shared';

interface RoomInternals {
  phase: string;
  hostId: number;
  tiles: TileBuffers;
  grid: { cols: number; rows: number; panelSize: number };
  states: Map<number, {
    id: number; x: number; y: number; facing: number; facingCursorRad: number;
    panelJumpCooldownS: number; stateSeq: number; name: string; ready: boolean;
    carbon: number; shockCooldownS: number; repairProgressS: number; shockHeldS: number;
  }>;
  crawlers: Map<number, {
    id: number; x: number; y: number; facing: number; hp: number;
    targetCx: number; targetCy: number; ai: number;
  }>;
  carbons: Map<number, unknown>;
  pilots: Map<number, unknown>;
  physicsStep(): void;
}

// Non-conductive L1 HP: below CONDUCTION_THRESHOLD × max but still > 0 so the
// panel exists. Mirrors what "DAMAGED" used to mean in the legacy trinary.
const NON_CONDUCTIVE_HP =
  Math.max(0, Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD) - 1);

test('shock kills crawler on adjacent conductive tile', () => {
  const room = new Room('TEST', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.tiles = allocateTiles(r.grid.cols, r.grid.rows);
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0, facingCursorRad: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0, shockHeldS: 0,
  });
  r.crawlers.set(1, {
    id: 1, x: 6 * 64 + 32, y: 5 * 64 + 32, facing: Math.PI, hp: 1,
    targetCx: 6, targetCy: 5, ai: CrawlerAIState.ATTACKING,
  });
  // Fake a pilot whose consumeInputForTick returns shock=true.
  const fakePilot = {
    isBot: false, ready: true, name: 'a',
    ackInputTick: 0, computeAckBitmask: () => 0,
    send: () => {},
    consumeInputForTick: () => ({
      tick: 0, clientTimeMs: 0, mx: 0, my: 0, shock: true, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0,
    }),
    dispose: () => {},
  };
  r.pilots.set(0, fakePilot);
  r.physicsStep();
  // Crawler dead, Carbon spawned.
  assert.equal(r.crawlers.size, 0, 'crawler killed');
  assert.equal(r.carbons.size, 1, 'carbon spawned at kill location');
});

test('shock cooldown enforced after first fire', () => {
  const room = new Room('TEST2', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.tiles = allocateTiles(r.grid.cols, r.grid.rows);
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0, facingCursorRad: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0, shockHeldS: 0,
  });
  r.pilots.set(0, {
    isBot: false, ready: true, name: 'a', ackInputTick: 0, computeAckBitmask: () => 0, send: () => {}, dispose: () => {},
    consumeInputForTick: () => ({ tick: 0, clientTimeMs: 0, mx: 0, my: 0, shock: true, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }),
  });
  r.physicsStep();
  const after = r.states.get(0)!;
  assert.ok(after.shockCooldownS > 0, `expected cooldown > 0 after fire, got ${after.shockCooldownS}`);
});

test('shock does not reach across a non-conductive tile', () => {
  const room = new Room('TEST3', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.tiles = allocateTiles(r.grid.cols, r.grid.rows);
  // Drop the L1 HP at the tile right of the player below the conduction
  // threshold so it doesn't conduct.
  r.tiles.l1Hp[indexOf(r.grid.cols, 6, 5)] = NON_CONDUCTIVE_HP;
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0, facingCursorRad: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0, shockHeldS: 0,
  });
  // Crawler standing on the non-conductive tile.
  r.crawlers.set(1, {
    id: 1, x: 6 * 64 + 32, y: 5 * 64 + 32, facing: Math.PI, hp: 1,
    targetCx: 6, targetCy: 5, ai: CrawlerAIState.ATTACKING,
  });
  r.pilots.set(0, {
    isBot: false, ready: true, name: 'a', ackInputTick: 0, computeAckBitmask: () => 0, send: () => {}, dispose: () => {},
    consumeInputForTick: () => ({ tick: 0, clientTimeMs: 0, mx: 0, my: 0, shock: true, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }),
  });
  r.physicsStep();
  assert.equal(r.crawlers.size, 1, 'crawler should survive — non-conductive tile blocks shock');
});
