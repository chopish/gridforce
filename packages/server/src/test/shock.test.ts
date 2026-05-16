import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import {
  CrawlerAIState,
  CONDUCTION_THRESHOLD,
  L1_PANEL_MAX_HP,
  SHOCK_LINGER_TICKS,
  allocateTiles,
  indexOf,
  type CrawlerState,
  type PlayerInput,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

// C1.2 hold-charge shock model:
//   - Held bit accumulates shockHeldS while down.
//   - Falling edge fires a ray-marched beam of length 1..MAX tiles, scaling
//     with shockHeldS.
//   - Each conductive tile in the path is electrified for SHOCK_LINGER_TICKS
//     server ticks; bugs on those tiles die immediately, and bugs that
//     walk onto a still-charged tile die on the next physicsStep linger sweep.

interface RoomInternals {
  phase: string;
  hostId: number;
  tiles: TileBuffers;
  grid: { cols: number; rows: number; panelSize: number };
  states: Map<number, PlayerState>;
  crawlers: Map<number, CrawlerState>;
  carbons: Map<number, unknown>;
  pilots: Map<number, unknown>;
  physicsStep(): void;
}

const NON_CONDUCTIVE_HP =
  Math.max(0, Math.ceil(L1_PANEL_MAX_HP * CONDUCTION_THRESHOLD) - 1);

const PLAYER_ID = 0;

function makeRoomInPlaying(): RoomInternals {
  const room = new Room('SHOCK', { visibility: 'unlisted' });
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
    id: PLAYER_ID, x, y,
    facing: 0, facingCursorRad: 0, panelJumpCooldownS: 0, stateSeq: 0,
    name: 'p', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0, shockHeldS: 0,
  });
}

function plantCrawler(r: RoomInternals, id: number, cx: number, cy: number): void {
  r.crawlers.set(id, {
    id,
    x: cx * r.grid.panelSize + r.grid.panelSize / 2,
    y: cy * r.grid.panelSize + r.grid.panelSize / 2,
    facing: Math.PI, hp: 1,
    targetCx: cx, targetCy: cy, ai: CrawlerAIState.ATTACKING,
  });
}

// Programmable per-tick input. Pop the head of `queue` each tick; once
// exhausted, return the last input forever (simulates "still held").
function setInputQueue(r: RoomInternals, queue: Array<{ shock: boolean; facingRad: number }>): void {
  let i = 0;
  const last = (): { shock: boolean; facingRad: number } =>
    queue.length === 0 ? { shock: false, facingRad: 0 } : queue[Math.min(i, queue.length - 1)]!;
  const fakePilot = {
    isBot: false, ready: true, name: 'p',
    ackInputTick: 0, computeAckBitmask: () => 0,
    send: () => {}, dispose: () => {},
    consumeInputForTick: (): PlayerInput => {
      const cur = last();
      i++;
      return {
        tick: 0, clientTimeMs: 0, mx: 0, my: 0,
        shock: cur.shock, repair: false,
        jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0,
        facingRad: cur.facingRad,
      };
    },
  };
  r.pilots.set(PLAYER_ID, fakePilot);
}

function tick(r: RoomInternals): void { r.physicsStep(); }

function playerState(r: RoomInternals): PlayerState { return r.states.get(PLAYER_ID)!; }

function crawlerAtTile(r: RoomInternals, cx: number, cy: number): CrawlerState | undefined {
  for (const c of r.crawlers.values()) {
    const ccx = Math.floor(c.x / r.grid.panelSize);
    const ccy = Math.floor(c.y / r.grid.panelSize);
    if (ccx === cx && ccy === cy) return c;
  }
  return undefined;
}

function assertCrawlerDead(r: RoomInternals, cx: number, cy: number, msg?: string): void {
  assert.equal(crawlerAtTile(r, cx, cy), undefined, msg ?? `crawler at (${cx},${cy}) should be dead`);
}

function assertCrawlerAlive(r: RoomInternals, cx: number, cy: number, msg?: string): void {
  assert.ok(crawlerAtTile(r, cx, cy) !== undefined, msg ?? `crawler at (${cx},${cy}) should be alive`);
}

// ─── Tests ─────────────────────────────────────────────────────────────

test('shock: held bit alone does NOT fire (rising edge retired)', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  plantCrawler(r, 1, 6, 5);
  // Hold for many ticks without ever releasing. Assert by id rather than
  // tile — C1.4's chase AI may walk the bug toward the player during the
  // hold; we only care that nobody died.
  setInputQueue(r, [{ shock: true, facingRad: 0 }]);
  for (let i = 0; i < 20; i++) tick(r);
  assert.ok(r.crawlers.has(1), 'no shock should fire while bit is held; bug must still exist');
});

test('shock: tap (release after one held tick) fires a 1-tile beam east', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  plantCrawler(r, 1, 6, 5);
  setInputQueue(r, [
    { shock: true, facingRad: 0 },   // tick 1: held
    { shock: false, facingRad: 0 },  // tick 2: released → fires
  ]);
  tick(r);
  tick(r);
  assertCrawlerDead(r, 6, 5);
  assert.ok(playerState(r).shockCooldownS > 0, 'cooldown should be set after fire');
});

test('shock: tap pointed west hits west tile', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  plantCrawler(r, 1, 4, 5);
  plantCrawler(r, 2, 6, 5);
  setInputQueue(r, [
    { shock: true, facingRad: Math.PI },
    { shock: false, facingRad: Math.PI },
  ]);
  tick(r); tick(r);
  assertCrawlerDead(r, 4, 5);
  assertCrawlerAlive(r, 6, 5);
});

test('shock: longer hold reaches more tiles in 360° aim direction', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  // Bugs at +1, +2, +3 tiles east. We use 22 hold ticks so the beam is
  // long enough to reach +3 but short enough that the chase-AI doesn't
  // pull the bugs out of their planted tiles before the release fires.
  plantCrawler(r, 1, 6, 5);
  plantCrawler(r, 2, 7, 5);
  plantCrawler(r, 3, 8, 5);
  const held = Array.from({ length: 22 }, () => ({ shock: true, facingRad: 0 }));
  held.push({ shock: false, facingRad: 0 });
  setInputQueue(r, held);
  for (let i = 0; i < held.length; i++) tick(r);
  assertCrawlerDead(r, 6, 5);
  assertCrawlerDead(r, 7, 5);
  assertCrawlerDead(r, 8, 5);
});

test('shock: a tap kills only the nearest tile, not further ones', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  plantCrawler(r, 1, 6, 5);
  plantCrawler(r, 2, 7, 5);
  setInputQueue(r, [
    { shock: true, facingRad: 0 },
    { shock: false, facingRad: 0 },
  ]);
  tick(r); tick(r);
  assertCrawlerDead(r, 6, 5);
  assertCrawlerAlive(r, 7, 5, 'tap should only reach 1 tile');
});

test('shock: beam breaks at a non-conductive tile', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  // Tile 6,5 is damaged-below-threshold; tile 7,5 has a bug.
  r.tiles.l1Hp[indexOf(r.grid.cols, 6, 5)] = NON_CONDUCTIVE_HP;
  plantCrawler(r, 1, 7, 5);
  // Hold long enough to produce a 2-tile beam (would reach the bug if not
  // blocked at the non-conductive intermediate tile).
  const held = Array.from({ length: 15 }, () => ({ shock: true, facingRad: 0 }));
  held.push({ shock: false, facingRad: 0 });
  setInputQueue(r, held);
  for (let i = 0; i < held.length; i++) tick(r);
  // Assert by id — chase AI may walk the bug westward during the hold,
  // but the beam should never have reached it across the dead tile.
  assert.ok(r.crawlers.has(1), 'non-conductive tile should break the beam');
});

test('shock: electrified tiles linger and kill bugs that walk into them', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  // Fire east — no bug present yet.
  setInputQueue(r, [
    { shock: true, facingRad: 0 },
    { shock: false, facingRad: 0 },
  ]);
  tick(r); tick(r);
  const idx = indexOf(r.grid.cols, 6, 5);
  assert.ok(r.tiles.l1Charge[idx]! > 0, 'tile should be charged after fire');
  // Now plant a bug onto the charged tile.
  plantCrawler(r, 99, 6, 5);
  // The next tick's linger sweep should fry it.
  tick(r);
  assertCrawlerDead(r, 6, 5, 'bug should die from lingering electricity');
});

test('shock: tile charge decays over time', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  setInputQueue(r, [
    { shock: true, facingRad: 0 },
    { shock: false, facingRad: 0 },
  ]);
  tick(r); tick(r);
  const idx = indexOf(r.grid.cols, 6, 5);
  const initial = r.tiles.l1Charge[idx]!;
  assert.ok(initial > 0);
  // After 5 more ticks, charge should have dropped by 5.
  for (let i = 0; i < 5; i++) tick(r);
  assert.ok(
    r.tiles.l1Charge[idx]! < initial,
    `charge should decay; was ${initial}, now ${r.tiles.l1Charge[idx]}`,
  );
});

test('shock: SHOCK_LINGER_TICKS sanity — charge stops after at most that many ticks', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  setInputQueue(r, [
    { shock: true, facingRad: 0 },
    { shock: false, facingRad: 0 },
  ]);
  tick(r); tick(r);
  const idx = indexOf(r.grid.cols, 6, 5);
  for (let i = 0; i < SHOCK_LINGER_TICKS + 5; i++) tick(r);
  assert.equal(r.tiles.l1Charge[idx], 0, 'charge should have fully decayed');
});
