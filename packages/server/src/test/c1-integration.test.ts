import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CrawlerAIState,
  L1_PANEL_MAX_HP,
  PANEL_SIZE,
  SERVER_TICK_DT_S,
  allocateTiles,
  indexOf,
  type CrawlerState,
  type PlayerInput,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

import { Room } from '../Room.js';

// Internal handles into the Room. Mirrors the pattern in shock.test.ts /
// panel-jump.test.ts / integrity.test.ts: cast through `unknown` to a minimal
// interface so tests can poke private state without making everything public.
interface RoomInternals {
  phase: string;
  hostId: number;
  tiles: TileBuffers;
  grid: { cols: number; rows: number; panelSize: number };
  states: Map<number, PlayerState>;
  crawlers: Map<number, CrawlerState>;
  carbons: Map<number, unknown>;
  pilots: Map<number, unknown>;
  // Spawner accumulator — driven from physicsStep; we keep it negative so the
  // ambient B1 trickle never contaminates planted-crawler scenarios.
  crawlerSpawnAccum: number;
  physicsStep(): void;
}

const PLAYER_ID = 0;
// Distinct id-space from the spawner (which starts at 0 and increments).
const TEST_ID_BASE = 0x8000;

function makeRoomInPlaying(): RoomInternals {
  const room = new Room('C1IT', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.tiles = allocateTiles(r.grid.cols, r.grid.rows);
  r.crawlers.clear();
  r.carbons.clear();
  return r;
}

function setPlayerAt(r: RoomInternals, cx: number, cy: number): void {
  const x = cx * r.grid.panelSize + r.grid.panelSize / 2;
  const y = cy * r.grid.panelSize + r.grid.panelSize / 2;
  r.states.set(PLAYER_ID, {
    id: PLAYER_ID,
    x,
    y,
    facing: 0,
    facingCursorRad: 0,
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name: 'p',
    ready: true,
    carbon: 0,
    shockCooldownS: 0,
    repairProgressS: 0,
    shockHeldS: 0,
  });
}

function planCrawlerAttacking(r: RoomInternals, cx: number, cy: number): number {
  // Allocate a stable id in the test id-space so we can find this crawler back
  // even if the ambient spawner ever fires.
  let id = TEST_ID_BASE;
  while (r.crawlers.has(id)) id++;
  r.crawlers.set(id, {
    id,
    x: cx * r.grid.panelSize + r.grid.panelSize / 2,
    y: cy * r.grid.panelSize + r.grid.panelSize / 2,
    // Face "west" so a TRANSITING transition would walk back off the
    // crawler's spawn edge, mirroring the real APPROACHING → ATTACKING flow.
    facing: Math.PI,
    hp: 1,
    targetCx: cx,
    targetCy: cy,
    ai: CrawlerAIState.ATTACKING,
  });
  return id;
}

interface ShockOpts {
  shock: boolean;
  facingRad: number;
}
function inputPlayerShock(r: RoomInternals, opts: ShockOpts): void {
  r.pilots.set(PLAYER_ID, {
    isBot: false,
    ready: true,
    name: 'p',
    ackInputTick: 0,
    computeAckBitmask: () => 0,
    send: () => {},
    dispose: () => {},
    consumeInputForTick: (): PlayerInput => ({
      tick: 0,
      clientTimeMs: 0,
      mx: 0,
      my: 0,
      shock: opts.shock,
      repair: false,
      jumpHeld: false,
      jumpCursorDx: 0,
      jumpCursorDy: 0,
      facingRad: opts.facingRad,
    }),
  });
}

interface JumpOpts {
  jumpHeld: boolean;
  jumpCursorDx: number;
  jumpCursorDy: number;
}
function inputPlayerJump(r: RoomInternals, opts: JumpOpts): void {
  r.pilots.set(PLAYER_ID, {
    isBot: false,
    ready: true,
    name: 'p',
    ackInputTick: 0,
    computeAckBitmask: () => 0,
    send: () => {},
    dispose: () => {},
    consumeInputForTick: (): PlayerInput => ({
      tick: 0,
      clientTimeMs: 0,
      mx: 0,
      my: 0,
      shock: false,
      repair: false,
      jumpHeld: opts.jumpHeld,
      jumpCursorDx: opts.jumpCursorDx,
      jumpCursorDy: opts.jumpCursorDy,
      facingRad: 0,
    }),
  });
}

function tick(r: RoomInternals): void {
  // Suppress the ambient spawner so it never adds non-test crawlers to scenes
  // that count or filter by ai state.
  r.crawlerSpawnAccum = -1e9;
  r.physicsStep();
}

function tickFor(r: RoomInternals, seconds: number): void {
  const ticks = Math.round(seconds / SERVER_TICK_DT_S);
  for (let i = 0; i < ticks; i++) tick(r);
}

function playerState(r: RoomInternals): PlayerState {
  return r.states.get(PLAYER_ID)!;
}

test('C1 e2e: single ATTACKING bug grinds L1 → exposed dome → passage → bug transits', () => {
  const room = makeRoomInPlaying();
  const id = planCrawlerAttacking(room, 0, 0);
  const idx = indexOf(room.grid.cols, 0, 0);

  // L1 grinds down. WEIGHT_THRESHOLD=4, 1 bug → 2 hp/s; L1=100 → ~50 seconds.
  // Take a quick check after 5s to confirm L1 is going down.
  tickFor(room, 5);
  assert.ok(
    room.tiles.l1Hp[idx]! < L1_PANEL_MAX_HP,
    `L1 should be reduced after 5s, got ${room.tiles.l1Hp[idx]!}`,
  );

  // Long-grind: an additional 60s pushes total to 65s — well past the ~50s
  // needed to drive a single-bug L1 to zero.
  tickFor(room, 60);
  assert.equal(room.tiles.l1Hp[idx]!, 0, 'L1 should be fully ground out');
  assert.ok(
    room.tiles.l0Hp[idx]! > 0,
    `L0 should still be intact, got ${room.tiles.l0Hp[idx]!}`,
  );

  // Crawler is still ATTACKING (L0 alive means tile is not yet a passage).
  const before = room.crawlers.get(id);
  assert.ok(before, 'planted crawler should still be alive');
  assert.equal(before.ai, CrawlerAIState.ATTACKING);

  // Speed-run by setting L0 close to 0 to avoid another ~100s of ticks.
  room.tiles.l0Hp[idx] = 5;
  tickFor(room, 5);
  assert.equal(room.tiles.l0Hp[idx], 0, 'L0 should now be destroyed');

  // Once both layers are 0 the tile is a passage and the planted bug should
  // transition out of ATTACKING (it walks off as TRANSITING). It may already
  // have left the world this same tick if facing carries it off the edge —
  // accept either "still alive and TRANSITING" or "already reaped".
  const after = room.crawlers.get(id);
  if (after) {
    assert.equal(
      after.ai,
      CrawlerAIState.TRANSITING,
      'planted crawler should leave ATTACKING once tile becomes a passage',
    );
  }
});

test('C1 e2e: cursor-aim uncharged shock kills only the cursor-direction crawler', () => {
  const room = makeRoomInPlaying();
  const eastId = planCrawlerAttacking(room, 6, 5);
  const westId = planCrawlerAttacking(room, 4, 5);
  setPlayerAt(room, 5, 5);

  // Aim east. Uncharged shock snaps to the cardinal nearest the cursor and
  // hits exactly one tile.
  inputPlayerShock(room, { shock: true, facingRad: 0 });
  tick(room);

  assert.equal(
    room.crawlers.get(eastId),
    undefined,
    'east crawler should be killed by cursor-aimed shock',
  );
  const survivor = room.crawlers.get(westId);
  assert.ok(survivor, 'west crawler should survive (not in cursor direction)');
  assert.equal(survivor.targetCx, 4);
});

test('C1 e2e: panel-jump teleports via cursor offsets within the 5×5 box', () => {
  const room = makeRoomInPlaying();
  setPlayerAt(room, 5, 5);

  // Hold Shift with cursor (2, -1) for one tick.
  inputPlayerJump(room, { jumpHeld: true, jumpCursorDx: 2, jumpCursorDy: -1 });
  tick(room);
  // Release on next tick — falling-edge of jumpHeld fires the teleport.
  inputPlayerJump(room, { jumpHeld: false, jumpCursorDx: 2, jumpCursorDy: -1 });
  tick(room);

  const pl = playerState(room);
  // Target tile = (5+2, 5-1) = (7, 4); player snaps to that tile's center.
  assert.ok(
    Math.abs(pl.x - (7 * PANEL_SIZE + PANEL_SIZE / 2)) < 1,
    `expected x ≈ ${7 * PANEL_SIZE + PANEL_SIZE / 2}, got ${pl.x}`,
  );
  assert.ok(
    Math.abs(pl.y - (4 * PANEL_SIZE + PANEL_SIZE / 2)) < 1,
    `expected y ≈ ${4 * PANEL_SIZE + PANEL_SIZE / 2}, got ${pl.y}`,
  );
});
