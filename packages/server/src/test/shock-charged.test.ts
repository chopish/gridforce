import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../Room.js';
import {
  CrawlerAIState,
  L1_PANEL_MAX_HP,
  SERVER_TICK_DT_S,
  SHOCK_CHARGE_COOLDOWN_S,
  SHOCK_CHARGE_TIME_S,
  allocateTiles,
  indexOf,
  type CrawlerState,
  type PlayerInput,
  type PlayerState,
  type TileBuffers,
} from '@gridforce/shared';

// Internal handles into the Room. Mirrors the pattern in shock.test.ts: cast
// through `unknown` to a minimal interface so the test can poke at private
// state without making everything public.
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

const PLAYER_ID = 0;

function makeRoomInPlaying(): RoomInternals {
  const room = new Room('CHRG', { visibility: 'unlisted' });
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

// One-shot input — same fakePilot pattern as shock.test.ts. Each tick the
// pilot returns the *current* opts, so re-calling inputPlayer between ticks
// swaps the held bit.
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

// Holding variant — the pilot keeps the shock bit set across every tick until
// a subsequent inputPlayer*() call replaces it. Used to simulate the held
// charge interval before the release.
function inputPlayerHolding(
  r: RoomInternals,
  opts: { shock: boolean; facingRad: number },
): void {
  inputPlayer(r, opts);
}

function tick(r: RoomInternals): void {
  r.physicsStep();
}

// Drive the room forward by ~seconds worth of physics ticks. Rounds to the
// nearest whole tick so the wall-clock budget here matches what physicsStep
// would see in production.
function tickFor(r: RoomInternals, seconds: number): void {
  const n = Math.max(1, Math.round(seconds / SERVER_TICK_DT_S));
  for (let i = 0; i < n; i++) tick(r);
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

test('held shock builds shockHeldS, clamps at SHOCK_CHARGE_TIME_S', () => {
  const r = makeRoomInPlaying();
  setPlayerAt(r, 5, 5);
  // Hold for 0.3s.
  inputPlayerHolding(r, { shock: true, facingRad: 0 });
  tickFor(r, 0.3);
  let pl = playerState(r);
  assert.ok(
    pl.shockHeldS >= 0.27 && pl.shockHeldS <= 0.33,
    `expected ~0.3s, got ${pl.shockHeldS}`,
  );
  // Overhold by 1.0s — should saturate at SHOCK_CHARGE_TIME_S (0.6s).
  tickFor(r, 1.0);
  pl = playerState(r);
  assert.ok(
    pl.shockHeldS <= SHOCK_CHARGE_TIME_S + 0.05,
    `expected <= ${SHOCK_CHARGE_TIME_S}, got ${pl.shockHeldS}`,
  );
});

test('release after full charge fires 2-tile cardinal line with conduction gate', () => {
  // Player at (5,5); crawlers at (6,5) and (7,5). All tiles LIVE.
  const r = makeRoomWithCrawlers([[6, 5], [7, 5]]);
  setPlayerAt(r, 5, 5);
  inputPlayerHolding(r, { shock: true, facingRad: 0 });
  tickFor(r, SHOCK_CHARGE_TIME_S + 0.05);
  // Rising-edge tap killed (6,5) on the first tick; replant it so we can
  // verify the charged release re-kills it on the falling edge.
  plantCrawler(r, 91, 6, 5);
  // Release.
  inputPlayer(r, { shock: false, facingRad: 0 });
  tick(r);
  assertCrawlerDead(r, 6, 5);
  assertCrawlerDead(r, 7, 5);
});

test('charged shock stops at non-conductive tile 1 — neither tile gets hit', () => {
  const r = makeRoomWithCrawlers([[6, 5], [7, 5]]);
  setPlayerAt(r, 5, 5);
  // Make tile 1 (6,5) DAMAGED below threshold BEFORE we start holding so the
  // rising-edge tap also fails and doesn't pre-kill (6,5).
  const idx1 = indexOf(r.grid.cols, 6, 5);
  r.tiles.l1Hp[idx1] = Math.floor(L1_PANEL_MAX_HP * 0.4);
  inputPlayerHolding(r, { shock: true, facingRad: 0 });
  tickFor(r, SHOCK_CHARGE_TIME_S + 0.05);
  inputPlayer(r, { shock: false, facingRad: 0 });
  tick(r);
  // Tile 1 is non-conductive => pulse fails immediately. Both crawlers survive.
  assertCrawlerAlive(r, 6, 5);
  assertCrawlerAlive(r, 7, 5);
});

test('charged shock hits tile 1 but not tile 2 when tile 2 is non-conductive', () => {
  const r = makeRoomWithCrawlers([[6, 5], [7, 5]]);
  setPlayerAt(r, 5, 5);
  // Tile 1 LIVE; tile 2 (7,5) DAMAGED.
  const idx2 = indexOf(r.grid.cols, 7, 5);
  r.tiles.l1Hp[idx2] = Math.floor(L1_PANEL_MAX_HP * 0.4);
  inputPlayerHolding(r, { shock: true, facingRad: 0 });
  tickFor(r, SHOCK_CHARGE_TIME_S + 0.05);
  // Rising-edge tap killed (6,5); replant so we can verify the charged
  // release also lands on tile 1 (and does NOT reach tile 2).
  plantCrawler(r, 92, 6, 5);
  inputPlayer(r, { shock: false, facingRad: 0 });
  tick(r);
  assertCrawlerDead(r, 6, 5);
  assertCrawlerAlive(r, 7, 5);
});

test('release before full charge does not fire charged (no extra kills beyond the rising-edge tap)', () => {
  // Same setup as full-charge test, but release after 0.2s — below
  // SHOCK_CHARGE_TIME_S.
  const r = makeRoomWithCrawlers([[6, 5], [7, 5]]);
  setPlayerAt(r, 5, 5);
  inputPlayerHolding(r, { shock: true, facingRad: 0 });
  tickFor(r, 0.2);
  inputPlayer(r, { shock: false, facingRad: 0 });
  tick(r);
  // Rising-edge tap killed (6,5); (7,5) survives because charged didn't fire.
  assertCrawlerDead(r, 6, 5);
  assertCrawlerAlive(r, 7, 5);
});

test('full-charge release sets SHOCK_CHARGE_COOLDOWN_S cooldown', () => {
  const r = makeRoomWithCrawlers([[6, 5]]);
  setPlayerAt(r, 5, 5);
  inputPlayerHolding(r, { shock: true, facingRad: 0 });
  tickFor(r, SHOCK_CHARGE_TIME_S + 0.05);
  inputPlayer(r, { shock: false, facingRad: 0 });
  tick(r);
  const pl = playerState(r);
  assert.ok(pl.shockCooldownS > 0);
  assert.ok(pl.shockCooldownS <= SHOCK_CHARGE_COOLDOWN_S);
});
