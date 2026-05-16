import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import {
  CrawlerAIState,
  CONDUCTION_THRESHOLD,
  L1_PANEL_MAX_HP,
  SHOCK_COOLDOWN_S,
  allocateTiles,
  indexOf,
  type CrawlerState,
  type PlayerInput,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

// Internal handles into the Room. Mirrors the pattern in repair.test.ts /
// integrity.test.ts: cast through `unknown` to a minimal interface so the
// test can poke at private state without making everything public.
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

// Non-conductive L1 HP: below CONDUCTION_THRESHOLD × max but still > 0 so the
// panel exists. Mirrors what "DAMAGED" used to mean in the legacy trinary.
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
    id: PLAYER_ID,
    x, y,
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

function plantCrawler(r: RoomInternals, id: number, cx: number, cy: number): void {
  r.crawlers.set(id, {
    id,
    x: cx * r.grid.panelSize + r.grid.panelSize / 2,
    y: cy * r.grid.panelSize + r.grid.panelSize / 2,
    facing: Math.PI,
    hp: 1,
    targetCx: cx,
    targetCy: cy,
    ai: CrawlerAIState.ATTACKING,
  });
}

function inputPlayer(
  r: RoomInternals,
  opts: { shock: boolean; facingRad: number },
): void {
  const fakePilot = {
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
  };
  r.pilots.set(PLAYER_ID, fakePilot);
}

function tick(r: RoomInternals): void {
  r.physicsStep();
}

function playerState(r: RoomInternals): PlayerState {
  return r.states.get(PLAYER_ID)!;
}

function crawlerAtTile(r: RoomInternals, cx: number, cy: number): CrawlerState | undefined {
  for (const c of r.crawlers.values()) {
    const ccx = Math.floor(c.x / r.grid.panelSize);
    const ccy = Math.floor(c.y / r.grid.panelSize);
    if (ccx === cx && ccy === cy) return c;
  }
  return undefined;
}

function assertCrawlerDead(r: RoomInternals, cx: number, cy: number): void {
  assert.equal(
    crawlerAtTile(r, cx, cy),
    undefined,
    `expected crawler at (${cx},${cy}) to be dead`,
  );
}

function assertCrawlerAlive(r: RoomInternals, cx: number, cy: number): void {
  assert.ok(
    crawlerAtTile(r, cx, cy) !== undefined,
    `expected crawler at (${cx},${cy}) to be alive`,
  );
}

function makeRoomWithCrawlers(positions: Array<[number, number]>): RoomInternals {
  const r = makeRoomInPlaying();
  let id = 1;
  for (const [cx, cy] of positions) {
    plantCrawler(r, id++, cx, cy);
  }
  return r;
}

test('uncharged shock fires on cursor-snapped cardinal only — east', () => {
  // Player center at tile (5,5); crawlers at (6,5) (east) and (4,5) (west).
  const r = makeRoomWithCrawlers([[6, 5], [4, 5]]);
  setPlayerAt(r, 5, 5);
  inputPlayer(r, { shock: true, facingRad: 0 /* east in screen-y-down */ });
  tick(r);
  assertCrawlerDead(r, 6, 5);
  assertCrawlerAlive(r, 4, 5);
});

test('uncharged shock at cursor pointing west hits west tile only', () => {
  const r = makeRoomWithCrawlers([[6, 5], [4, 5]]);
  setPlayerAt(r, 5, 5);
  inputPlayer(r, { shock: true, facingRad: Math.PI });
  tick(r);
  assertCrawlerDead(r, 4, 5);
  assertCrawlerAlive(r, 6, 5);
});

test('uncharged shock pointing south hits south tile only', () => {
  const r = makeRoomWithCrawlers([[5, 6], [5, 4]]);
  setPlayerAt(r, 5, 5);
  inputPlayer(r, { shock: true, facingRad: Math.PI / 2 });
  tick(r);
  assertCrawlerDead(r, 5, 6);
  assertCrawlerAlive(r, 5, 4);
});

test('uncharged shock pointing north hits north tile only', () => {
  const r = makeRoomWithCrawlers([[5, 6], [5, 4]]);
  setPlayerAt(r, 5, 5);
  inputPlayer(r, { shock: true, facingRad: -Math.PI / 2 });
  tick(r);
  assertCrawlerDead(r, 5, 4);
  assertCrawlerAlive(r, 5, 6);
});

test('uncharged shock on non-conductive tile is a no-op (damaged below threshold)', () => {
  const r = makeRoomWithCrawlers([[6, 5]]);
  setPlayerAt(r, 5, 5);
  r.tiles.l1Hp[indexOf(r.grid.cols, 6, 5)] = NON_CONDUCTIVE_HP;
  inputPlayer(r, { shock: true, facingRad: 0 });
  tick(r);
  assertCrawlerAlive(r, 6, 5);
});

test('uncharged shock sets cooldown on PlayerState', () => {
  const r = makeRoomWithCrawlers([[6, 5]]);
  setPlayerAt(r, 5, 5);
  inputPlayer(r, { shock: true, facingRad: 0 });
  tick(r);
  const pl = playerState(r);
  assert.ok(pl.shockCooldownS > 0, `expected cooldown > 0, got ${pl.shockCooldownS}`);
  assert.ok(pl.shockCooldownS <= SHOCK_COOLDOWN_S);
});

test('uncharged shock pointed off-grid is a no-op (no cooldown charged)', () => {
  // Player at top-left edge tile (0,0); aim north — no tile there.
  const r = makeRoomWithCrawlers([]);
  setPlayerAt(r, 0, 0);
  inputPlayer(r, { shock: true, facingRad: -Math.PI / 2 });
  tick(r);
  // Plan pseudocode early-returns BEFORE setting cooldown, so cooldown stays 0.
  const pl = playerState(r);
  assert.equal(pl.shockCooldownS, 0);
});

test('holding shock for multiple ticks fires only on rising edge', () => {
  const r = makeRoomWithCrawlers([[6, 5]]);
  setPlayerAt(r, 5, 5);
  inputPlayer(r, { shock: true, facingRad: 0 });
  tick(r);
  // Crawler dies on first tick; cooldown now > 0.
  assertCrawlerDead(r, 6, 5);
  const after1 = playerState(r);
  assert.ok(after1.shockCooldownS > 0);
  // Replant a crawler and hold shock — same held bit, no rising edge, so
  // no additional shock fires even after cooldown ticks down. We hammer
  // many ticks with shock continuously held; not a single one should fire.
  plantCrawler(r, 99, 6, 5);
  // Drain ticks. shockCooldownS is SHOCK_COOLDOWN_S; SERVER_TICK_DT_S=1/30,
  // so ~8 ticks at 0.25s/0.033s ≈ 8. Run 30 to be safe (~1s of held shock).
  for (let i = 0; i < 30; i++) tick(r);
  // Crawler should still be alive because rising-edge never fired again.
  assertCrawlerAlive(r, 6, 5);
});

test('shock does not reach across a non-conductive tile (regression)', () => {
  // Belt-and-suspenders: damaged-below-threshold tile to the east blocks shock.
  const r = makeRoomWithCrawlers([[6, 5]]);
  setPlayerAt(r, 5, 5);
  r.tiles.l1Hp[indexOf(r.grid.cols, 6, 5)] = NON_CONDUCTIVE_HP;
  inputPlayer(r, { shock: true, facingRad: 0 });
  tick(r);
  assertCrawlerAlive(r, 6, 5);
});
