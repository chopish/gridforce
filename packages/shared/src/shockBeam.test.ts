import test from 'node:test';
import assert from 'node:assert/strict';
import {
  L1_PANEL_MAX_HP,
  SHOCK_BEAM_MAX_TILES,
  SHOCK_CHARGE_COOLDOWN_S,
  SHOCK_CHARGE_FULL_S,
  SHOCK_COOLDOWN_S,
  allocateTiles,
  indexOf,
  newPlayerState,
  traceShockBeam,
  type PlayerInput,
  type PlayerState,
} from './index.js';

// Sized to fit a full-charge beam (SHOCK_BEAM_MAX_TILES) plus a player
// position with headroom on every side, so the full-charge test isn't
// silently clipped by grid bounds.
const COLS = 16;
const ROWS = 16;
const PANEL = 64;
const GRID = { cols: COLS, rows: ROWS, panelSize: PANEL };

function playerAtTile(cx: number, cy: number, heldS = 0): PlayerState {
  return {
    ...newPlayerState(0, cx * PANEL + PANEL / 2, cy * PANEL + PANEL / 2),
    shockHeldS: heldS,
  };
}

function fireEast(facingRad = 0): PlayerInput {
  return {
    tick: 0,
    clientTimeMs: 0,
    mx: 0, my: 0,
    shock: false, repair: false,
    jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0,
    facingRad,
  };
}

test('traceShockBeam: tap (zero-charge) returns exactly one conductive hit east', () => {
  const tiles = allocateTiles(COLS, ROWS);
  const state = playerAtTile(2, 2, 0);
  const trace = traceShockBeam(state, fireEast(), tiles, GRID);
  assert.equal(trace.hits.length, 1);
  assert.equal(trace.hits[0]!.tx, 3);
  assert.equal(trace.hits[0]!.ty, 2);
  assert.equal(trace.hits[0]!.conductive, true);
  assert.equal(trace.cooldownS, SHOCK_COOLDOWN_S);
});

test('traceShockBeam: full charge returns SHOCK_BEAM_MAX_TILES conductive hits and charged cooldown', () => {
  const tiles = allocateTiles(COLS, ROWS);
  const state = playerAtTile(2, 2, SHOCK_CHARGE_FULL_S);
  const trace = traceShockBeam(state, fireEast(), tiles, GRID);
  assert.equal(trace.hits.length, SHOCK_BEAM_MAX_TILES);
  for (let i = 0; i < trace.hits.length; i++) {
    assert.equal(trace.hits[i]!.tx, 3 + i);
    assert.equal(trace.hits[i]!.conductive, true);
  }
  assert.equal(trace.cooldownS, SHOCK_CHARGE_COOLDOWN_S);
});

test('traceShockBeam: damaged tile in path is included as a non-conductive impact and stops propagation', () => {
  const tiles = allocateTiles(COLS, ROWS);
  // Drop tile (4,2) below conduction threshold so the beam bounces there.
  tiles.l1Hp[indexOf(COLS, 4, 2)] = 1;
  const state = playerAtTile(2, 2, SHOCK_CHARGE_FULL_S);
  const trace = traceShockBeam(state, fireEast(), tiles, GRID);
  // Tiles 3 (live) and 4 (impact) — beam stops at the non-conductive tile.
  assert.equal(trace.hits.length, 2);
  assert.equal(trace.hits[0]!.tx, 3);
  assert.equal(trace.hits[0]!.conductive, true);
  assert.equal(trace.hits[1]!.tx, 4);
  assert.equal(trace.hits[1]!.conductive, false);
});

test('traceShockBeam: dead L1 tile is also a valid impact target (kills enemies on destroyed tiles)', () => {
  const tiles = allocateTiles(COLS, ROWS);
  tiles.l1Hp[indexOf(COLS, 3, 2)] = 0; // panel completely gone — exposed dome
  const state = playerAtTile(2, 2, 0);
  const trace = traceShockBeam(state, fireEast(), tiles, GRID);
  assert.equal(trace.hits.length, 1);
  assert.equal(trace.hits[0]!.conductive, false);
});

test('traceShockBeam: beam stops at the grid edge without overflowing the index', () => {
  const tiles = allocateTiles(COLS, ROWS);
  // Place player one tile from the eastern edge and fire east at full charge.
  const state = playerAtTile(COLS - 2, 2, SHOCK_CHARGE_FULL_S);
  const trace = traceShockBeam(state, fireEast(), tiles, GRID);
  // Only the edge-most live tile fits inside the grid.
  assert.equal(trace.hits.length, 1);
  assert.equal(trace.hits[0]!.tx, COLS - 1);
  for (const h of trace.hits) {
    assert.ok(h.tx >= 0 && h.tx < COLS);
    assert.ok(h.ty >= 0 && h.ty < ROWS);
  }
});

test('traceShockBeam: idx matches indexOf(cols, tx, ty) for every hit', () => {
  const tiles = allocateTiles(COLS, ROWS);
  // Damaged tile in the middle so we hit a mix of conductive + impact.
  tiles.l1Hp[indexOf(COLS, 4, 2)] = Math.ceil(L1_PANEL_MAX_HP / 2) - 1;
  const state = playerAtTile(2, 2, SHOCK_CHARGE_FULL_S);
  const trace = traceShockBeam(state, fireEast(), tiles, GRID);
  for (const h of trace.hits) {
    assert.equal(h.idx, indexOf(COLS, h.tx, h.ty));
  }
});
