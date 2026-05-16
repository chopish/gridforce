import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateTiles, indexOf, type TileBuffers } from '../tiles.js';
import { stepCrawler, type CrawlerStepContext } from './crawler.js';
import { CrawlerAIState, type CrawlerState, type PlayerState } from '../types.js';

const GRID = { cols: 18, rows: 12, panelSize: 64 };

function makePlayer(x: number, y: number): PlayerState {
  return {
    id: 0, x, y,
    facing: 0, facingCursorRad: 0, panelJumpCooldownS: 0, stateSeq: 0,
    name: 'p', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0, shockHeldS: 0,
  };
}

function makeCtx(players: PlayerState[], tiles?: TileBuffers): CrawlerStepContext {
  return { tiles: tiles ?? allocateTiles(GRID.cols, GRID.rows), players };
}

test('crawler chases the nearest player even when sitting on an intact panel', () => {
  // C1.3: bugs commit to chase. They no longer stop at tile centres to
  // grind a single panel forever — the panel takes damage in transit.
  const c: CrawlerState = {
    id: 1,
    x: 1 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0, hp: 1,
    targetCx: 1, targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
  };
  const ctx = makeCtx([makePlayer(10 * GRID.panelSize, 5 * GRID.panelSize + GRID.panelSize / 2)]);
  const after = stepCrawler(c, 0.1, GRID, ctx);
  assert.equal(after.ai, CrawlerAIState.APPROACHING, 'should be APPROACHING (moving)');
  assert.ok(after.x > c.x, 'bug must advance toward player');
});

test('crawler moves faster across a destroyed (passage-pending) tile than an intact one', () => {
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  tiles.l1Hp[indexOf(GRID.cols, 1, 5)] = 0;
  const onPassageTile: CrawlerState = {
    id: 1,
    x: 1 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0, hp: 1, targetCx: 1, targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
  };
  const onIntactTile: CrawlerState = { ...onPassageTile };
  const tilesIntact = allocateTiles(GRID.cols, GRID.rows);
  const player = makePlayer(10 * GRID.panelSize, 5 * GRID.panelSize + GRID.panelSize / 2);
  const a = stepCrawler(onPassageTile, 0.1, GRID, makeCtx([player], tiles));
  const b = stepCrawler(onIntactTile, 0.1, GRID, makeCtx([player], tilesIntact));
  assert.ok(a.x - onPassageTile.x > b.x - onIntactTile.x, 'passage step > intact step');
});

test('crawler retargets to the new nearest player each tick', () => {
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0, hp: 1, targetCx: 5, targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
  };
  const playerA = makePlayer(15 * GRID.panelSize, 5 * GRID.panelSize + GRID.panelSize / 2);
  const playerB = makePlayer(0, 5 * GRID.panelSize + GRID.panelSize / 2);
  const afterA = stepCrawler(c, 0.1, GRID, makeCtx([playerA]));
  assert.ok(afterA.x > c.x, 'bug heads east toward A');
  const afterB = stepCrawler(c, 0.1, GRID, makeCtx([playerB]));
  assert.ok(afterB.x < c.x, 'bug heads west toward B');
});

test('crawler with no players in the room idles in ATTACKING state', () => {
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + 10, y: 5 * GRID.panelSize + 10,
    facing: 0, hp: 1, targetCx: 5, targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
  };
  const after = stepCrawler(c, 0.1, GRID, makeCtx([]));
  assert.equal(after.ai, CrawlerAIState.ATTACKING);
  assert.equal(after.x, c.x, 'no players → no movement');
  assert.equal(after.y, c.y);
});

test('crawler off-grid still walks (toward player) when a player exists', () => {
  // Spawn position from the top edge: y just outside the map.
  const c: CrawlerState = {
    id: 1,
    x: 10 * GRID.panelSize + GRID.panelSize / 2,
    y: -GRID.panelSize / 2,
    facing: 0, hp: 1, targetCx: 10, targetCy: 0,
    ai: CrawlerAIState.APPROACHING,
  };
  const player = makePlayer(10 * GRID.panelSize, 6 * GRID.panelSize);
  const after = stepCrawler(c, 0.1, GRID, makeCtx([player]));
  assert.ok(after.y > c.y, 'off-grid bug must walk into the map');
  assert.equal(after.ai, CrawlerAIState.APPROACHING);
});

test('crawler step does not mutate tile HP directly (Room aggregates weight)', () => {
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0, hp: 1, targetCx: 5, targetCy: 5,
    ai: CrawlerAIState.ATTACKING,
  };
  const ctx = makeCtx([makePlayer(10 * GRID.panelSize, 5 * GRID.panelSize)]);
  const before = ctx.tiles.l1Hp[indexOf(GRID.cols, 5, 5)];
  stepCrawler(c, 1.0, GRID, ctx);
  assert.equal(ctx.tiles.l1Hp[indexOf(GRID.cols, 5, 5)], before);
});
