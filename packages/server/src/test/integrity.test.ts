import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_DOT_RATE,
  CRAWLER_WEIGHT,
  CrawlerAIState,
  L1_PANEL_MAX_HP,
  WEIGHT_THRESHOLD,
  allocateTiles,
  indexOf,
  type CrawlerState,
  type TileBuffers,
} from '@gridforce/shared';

import { Room } from '../Room.js';

// Internal handles into the Room — mirrors the pattern in repair.test.ts.
interface RoomInternals {
  phase: string;
  tiles: TileBuffers;
  grid: { cols: number; rows: number; panelSize: number };
  crawlers: Map<number, CrawlerState>;
  physicsStep(): void;
}

// Drop the Room into 'playing' so physicsStep runs the integrity loop.
// Reset tiles so every L1 panel is at L1_PANEL_MAX_HP for deterministic
// damage assertions, and clear any spawner state from prior steps.
function makeRoomForIntegrity(): RoomInternals {
  const room = new Room('IT', { visibility: 'unlisted' });
  const r = room as unknown as RoomInternals;
  r.phase = 'playing';
  r.tiles = allocateTiles(r.grid.cols, r.grid.rows);
  // Ensure no carry-over crawlers from spawner state.
  r.crawlers.clear();
  return r;
}

function plantAttacker(
  r: RoomInternals,
  id: number,
  cx: number,
  cy: number,
): void {
  r.crawlers.set(id, {
    id,
    x: cx * r.grid.panelSize + r.grid.panelSize / 2,
    y: cy * r.grid.panelSize + r.grid.panelSize / 2,
    facing: 0,
    hp: 1,
    targetCx: cx,
    targetCy: cy,
    ai: CrawlerAIState.ATTACKING,
  });
}

function plantTransiting(
  r: RoomInternals,
  id: number,
  cx: number,
  cy: number,
): void {
  r.crawlers.set(id, {
    id,
    x: cx * r.grid.panelSize + r.grid.panelSize / 2,
    y: cy * r.grid.panelSize + r.grid.panelSize / 2,
    facing: 0,
    hp: 1,
    targetCx: cx,
    targetCy: cy,
    ai: CrawlerAIState.TRANSITING,
  });
}

function plantApproaching(
  r: RoomInternals,
  id: number,
  cx: number,
  cy: number,
): void {
  r.crawlers.set(id, {
    id,
    // Park well outside the half-panel transition threshold so stepCrawler
    // keeps it APPROACHING rather than flipping it to ATTACKING.
    x: cx * r.grid.panelSize + r.grid.panelSize / 2 + r.grid.panelSize * 4,
    y: cy * r.grid.panelSize + r.grid.panelSize / 2,
    facing: Math.PI,
    hp: 1,
    targetCx: cx,
    targetCy: cy,
    ai: CrawlerAIState.APPROACHING,
  });
}

// Run `seconds` worth of ticks at the server tick rate.
function tickFor(r: RoomInternals, seconds: number): void {
  const dt = 1 / 30; // SERVER_TICK_DT_S
  const ticks = Math.round(seconds / dt);
  for (let i = 0; i < ticks; i++) r.physicsStep();
}

// Test crawler ids start at 0x8000 so they never collide with the spawner's
// monotonic id sequence (Room.spawnCrawler starts at 0). The spawner can
// still fire ~once/second while phase='playing'; we just need its bugs to
// land in different Map slots than our planted ones.
const TEST_ID_BASE = 0x8000;

test('integrity: one ATTACKING crawler damages target L1 at the linear rate', () => {
  // Place the bug well inside the grid so 4 cardinal neighbours all exist.
  const cx = 10;
  const cy = 10;
  const r = makeRoomForIntegrity();
  plantAttacker(r, TEST_ID_BASE, cx, cy);

  const idx = indexOf(r.grid.cols, cx, cy);
  const before = r.tiles.l1Hp[idx]!;
  tickFor(r, 1.0);
  const after = r.tiles.l1Hp[idx]!;
  const loss = before - after;

  // 1 ATTACKING crawler → load = CRAWLER_WEIGHT (target tile only; the four
  // neighbours are empty). Linear regime: dps = BASE_DOT_RATE × 1 = 2 hp/s.
  const expected = BASE_DOT_RATE * CRAWLER_WEIGHT;
  // Allow a small tolerance for tick rounding (30 Hz over 1s = 30 ticks).
  assert.ok(
    loss >= expected - 1 && loss <= expected + 1,
    `1 bug: expected ~${expected}hp loss over 1s, got ${loss}`,
  );
});

test('integrity: five ATTACKING crawlers stacked on one tile cross into quadratic regime', () => {
  // WEIGHT_THRESHOLD = 4. Self-weight = 5 × CRAWLER_WEIGHT = 5 > threshold.
  // dps = BASE × (5 + (5-4)²) = 2 × 6 = 12 hp/s.
  const cx = 10;
  const cy = 10;
  const r = makeRoomForIntegrity();
  for (let i = 0; i < 5; i++) plantAttacker(r, TEST_ID_BASE + i, cx, cy);

  const idx = indexOf(r.grid.cols, cx, cy);
  const before = r.tiles.l1Hp[idx]!;
  tickFor(r, 1.0);
  const after = r.tiles.l1Hp[idx]!;
  const loss = before - after;

  const w = 5 * CRAWLER_WEIGHT;
  const over = w - WEIGHT_THRESHOLD;
  const expected = BASE_DOT_RATE * (w + over * over);
  assert.ok(
    loss >= expected - 2 && loss <= expected + 2,
    `5 bugs (quadratic): expected ~${expected}hp loss over 1s, got ${loss}`,
  );
});

test('integrity: TRANSITING crawler contributes no weight (no damage)', () => {
  const cx = 10;
  const cy = 10;
  const r = makeRoomForIntegrity();
  plantTransiting(r, TEST_ID_BASE, cx, cy);

  const idx = indexOf(r.grid.cols, cx, cy);
  const before = r.tiles.l1Hp[idx]!;
  // One tick only — TRANSITING bugs drift and may exit/respawn over longer
  // windows; we only care that they don't damage tiles.
  r.physicsStep();
  const after = r.tiles.l1Hp[idx]!;
  assert.equal(after, before, 'TRANSITING bug should not damage its tile');
});

test('integrity: APPROACHING crawler contributes no weight (no damage)', () => {
  const cx = 10;
  const cy = 10;
  const r = makeRoomForIntegrity();
  plantApproaching(r, TEST_ID_BASE, cx, cy);

  const idx = indexOf(r.grid.cols, cx, cy);
  const before = r.tiles.l1Hp[idx]!;
  // One tick — the bug walks toward target but stays APPROACHING for many
  // ticks given the parking distance.
  r.physicsStep();
  const after = r.tiles.l1Hp[idx]!;
  assert.equal(after, before, 'APPROACHING bug should not damage its tile');
});

test('integrity: cardinal neighbours are untouched by a single attacker', () => {
  // A single ATTACKING crawler should damage ONLY its target tile. The
  // earlier 4-cardinal weight-spread was retired in C1.1 because playtest
  // showed bugs leaving a trail of partially damaged tiles behind a fully
  // destroyed one, which read as confusing and made the kill window
  // ambiguous. Stacking weight still triggers quadratic damage on the
  // target tile, so swarms still feel devastating.
  const cx = 10;
  const cy = 10;
  const r = makeRoomForIntegrity();
  plantAttacker(r, TEST_ID_BASE, cx, cy);

  const targetIdx = indexOf(r.grid.cols, cx, cy);
  const beforeTarget = r.tiles.l1Hp[targetIdx]!;
  const beforeN = r.tiles.l1Hp[indexOf(r.grid.cols, cx, cy - 1)]!;
  const beforeE = r.tiles.l1Hp[indexOf(r.grid.cols, cx + 1, cy)]!;
  const beforeS = r.tiles.l1Hp[indexOf(r.grid.cols, cx, cy + 1)]!;
  const beforeW = r.tiles.l1Hp[indexOf(r.grid.cols, cx - 1, cy)]!;

  tickFor(r, 1.0);

  assert.ok(
    beforeTarget - r.tiles.l1Hp[targetIdx]! > 0,
    'target tile should take damage',
  );
  assert.equal(r.tiles.l1Hp[indexOf(r.grid.cols, cx, cy - 1)]!, beforeN, 'N neighbour untouched');
  assert.equal(r.tiles.l1Hp[indexOf(r.grid.cols, cx + 1, cy)]!, beforeE, 'E neighbour untouched');
  assert.equal(r.tiles.l1Hp[indexOf(r.grid.cols, cx, cy + 1)]!, beforeS, 'S neighbour untouched');
  assert.equal(r.tiles.l1Hp[indexOf(r.grid.cols, cx - 1, cy)]!, beforeW, 'W neighbour untouched');
});

test('integrity: diagonal neighbour is untouched', () => {
  const cx = 10;
  const cy = 10;
  const r = makeRoomForIntegrity();
  plantAttacker(r, TEST_ID_BASE, cx, cy);

  const diagIdx = indexOf(r.grid.cols, cx + 1, cy + 1);
  const before = r.tiles.l1Hp[diagIdx]!;
  tickFor(r, 1.0);
  const after = r.tiles.l1Hp[diagIdx]!;
  assert.equal(after, before, 'diagonal tile should be untouched');
});

test('integrity: damage is capped at 0 (no underflow) and stops at L1 destruction', () => {
  const cx = 10;
  const cy = 10;
  const r = makeRoomForIntegrity();
  // Lots of bugs to grind through L1 quickly, plus a long run.
  for (let i = 0; i < 5; i++) plantAttacker(r, TEST_ID_BASE + i, cx, cy);
  const idx = indexOf(r.grid.cols, cx, cy);
  // Tick long enough to fully destroy L1 (max 100 HP, 12 hp/s → ~9s).
  tickFor(r, 30);
  const l1 = r.tiles.l1Hp[idx]!;
  // L1 must hit 0 and never go negative.
  assert.equal(l1, 0, `L1 should be fully destroyed, got ${l1}`);
  // Sanity: L1 max is 100, so we should be well past it.
  assert.ok(L1_PANEL_MAX_HP > 0);
});
