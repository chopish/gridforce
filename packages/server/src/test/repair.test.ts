import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import { PanelState, REPAIR_DURATION_S, REPAIR_CARBON_COST, allLive, indexOf } from '@gridforce/shared';

interface RoomInternals {
  phase: string;
  hostId: number;
  panelStates: Uint8Array;
  grid: { cols: number; rows: number; panelSize: number };
  states: Map<number, {
    id: number; x: number; y: number; facing: number;
    panelJumpCooldownS: number; stateSeq: number; name: string; ready: boolean;
    carbon: number; shockCooldownS: number; repairProgressS: number;
  }>;
  crawlers: Map<number, {
    id: number; x: number; y: number; facing: number; hp: number;
    targetCx: number; targetCy: number; ai: number;
  }>;
  carbons: Map<number, unknown>;
  pilots: Map<number, unknown>;
  physicsStep(): void;
}

function pilotWithRepair(repair: boolean) {
  return {
    isBot: false, ready: true, name: 'a',
    ackInputTick: 0, computeAckBitmask: () => 0,
    send: () => {}, dispose: () => {},
    consumeInputForTick: () => ({
      tick: 0, clientTimeMs: 0, mx: 0, my: 0, shock: false, repair, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0,
    }),
  };
}

test('holding repair on DAMAGED tile with carbon flips to LIVE after 1.5s', () => {
  const room = new Room('TR', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.panelStates = allLive(r.grid.cols, r.grid.rows);
  // Damage the tile at (5, 5).
  r.panelStates[indexOf(r.grid.cols, 5, 5)] = PanelState.DAMAGED;
  // Place a player on tile (5, 5) with 5 carbon.
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 5, shockCooldownS: 0, repairProgressS: 0,
  });
  r.pilots.set(0, pilotWithRepair(true));
  // Tick until progress meets duration.
  const dt = 1 / 30;
  const ticks = Math.ceil(REPAIR_DURATION_S / dt) + 1;
  for (let i = 0; i < ticks; i++) r.physicsStep();
  assert.equal(r.panelStates[indexOf(r.grid.cols, 5, 5)], PanelState.LIVE);
  assert.equal(r.states.get(0)!.carbon, 5 - REPAIR_CARBON_COST);
  assert.equal(r.states.get(0)!.repairProgressS, 0);
});

test('releasing repair resets the progress timer', () => {
  const room = new Room('TR2', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.panelStates = allLive(r.grid.cols, r.grid.rows);
  r.panelStates[indexOf(r.grid.cols, 5, 5)] = PanelState.DAMAGED;
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 1, shockCooldownS: 0, repairProgressS: 0,
  });
  let repairing = true;
  r.pilots.set(0, {
    isBot: false, ready: true, name: 'a', ackInputTick: 0, computeAckBitmask: () => 0, send: () => {}, dispose: () => {},
    consumeInputForTick: () => ({ tick: 0, clientTimeMs: 0, mx: 0, my: 0, shock: false, repair: repairing, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 }),
  });
  for (let i = 0; i < 10; i++) r.physicsStep(); // ~0.33s of repair
  assert.ok(r.states.get(0)!.repairProgressS > 0);
  // Release.
  repairing = false;
  r.physicsStep();
  assert.equal(r.states.get(0)!.repairProgressS, 0);
});

test('repair does nothing on a LIVE tile', () => {
  const room = new Room('TR3', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.panelStates = allLive(r.grid.cols, r.grid.rows);
  // Player on LIVE tile (default).
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 5, shockCooldownS: 0, repairProgressS: 0,
  });
  r.pilots.set(0, pilotWithRepair(true));
  for (let i = 0; i < 50; i++) r.physicsStep();
  assert.equal(r.states.get(0)!.carbon, 5, 'no carbon spent');
  assert.equal(r.states.get(0)!.repairProgressS, 0, 'no progress accrued');
});

test('repair does nothing with 0 carbon', () => {
  const room = new Room('TR4', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.panelStates = allLive(r.grid.cols, r.grid.rows);
  r.panelStates[indexOf(r.grid.cols, 5, 5)] = PanelState.DAMAGED;
  r.states.set(0, {
    id: 0, x: 5 * 64 + 32, y: 5 * 64 + 32, facing: 0,
    panelJumpCooldownS: 0, stateSeq: 0, name: 'a', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0,
  });
  r.pilots.set(0, pilotWithRepair(true));
  for (let i = 0; i < 50; i++) r.physicsStep();
  assert.equal(r.panelStates[indexOf(r.grid.cols, 5, 5)], PanelState.DAMAGED, 'tile still damaged');
  assert.equal(r.states.get(0)!.repairProgressS, 0, 'no progress accrued');
});
