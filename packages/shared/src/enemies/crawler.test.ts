import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateTiles, indexOf, type TileBuffers } from '../tiles.js';
import { stepCrawler, type CrawlerStepContext } from './crawler.js';
import { CrawlerAIState, type CrawlerState, type PlayerState } from '../types.js';

const GRID = { cols: 18, rows: 12, panelSize: 64 };

function makePlayer(x: number, y: number): PlayerState {
  return {
    id: 0,
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
  };
}

function makeCtx(players: PlayerState[], tiles?: TileBuffers): CrawlerStepContext {
  return { tiles: tiles ?? allocateTiles(GRID.cols, GRID.rows), players };
}

test('crawler walks toward nearest player when starting on an intact panel', () => {
  // Crawler at (1,5) tile centre; player at (10,5). Bug should head east.
  const c: CrawlerState = {
    id: 1,
    x: 1 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0,
    hp: 1,
    targetCx: 1,
    targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
  };
  const ctx = makeCtx([makePlayer(10 * GRID.panelSize, 5 * GRID.panelSize + GRID.panelSize / 2)]);
  // Start ATTACKING — bug is at the centre of an intact panel, so the first
  // step should be to dwell-attack here, NOT to march toward the player yet.
  const after = stepCrawler(c, 0.1, GRID, ctx);
  assert.equal(after.ai, CrawlerAIState.ATTACKING, 'should attack the intact panel it stands on');
});

test('crawler walks toward player once the panel under it is destroyed', () => {
  // Same setup, but the panel under (1,5) is gone — bug should march east.
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  tiles.l1Hp[indexOf(GRID.cols, 1, 5)] = 0;
  const c: CrawlerState = {
    id: 1,
    x: 1 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0,
    hp: 1,
    targetCx: 1,
    targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
  };
  const ctx = makeCtx(
    [makePlayer(10 * GRID.panelSize, 5 * GRID.panelSize + GRID.panelSize / 2)],
    tiles,
  );
  const after = stepCrawler(c, 0.1, GRID, ctx);
  assert.ok(after.x > c.x, 'bug should advance toward player when current tile has no panel');
});

test('crawler retargets to a new nearest player each tick', () => {
  // Far away from both; nearest is player A to the east. After A leaves the
  // scene, the bug should turn toward player B to the west.
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0,
    hp: 1,
    targetCx: 5,
    targetCy: 5,
    ai: CrawlerAIState.ATTACKING,
  };
  // Destroy the panel under the bug so APPROACHING walks toward player.
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  tiles.l1Hp[indexOf(GRID.cols, 5, 5)] = 0;
  const playerA = makePlayer(15 * GRID.panelSize, 5 * GRID.panelSize + GRID.panelSize / 2);
  const playerB = makePlayer(0, 5 * GRID.panelSize + GRID.panelSize / 2);
  // Player A present: bug moves east.
  const afterA = stepCrawler(c, 0.1, GRID, makeCtx([playerA], tiles));
  assert.ok(afterA.x > c.x, 'bug heads east toward A');
  // Player B only: bug moves west.
  const afterB = stepCrawler(c, 0.1, GRID, makeCtx([playerB], tiles));
  assert.ok(afterB.x < c.x, 'bug heads west toward B');
});

test('crawler with no players in the room idles in ATTACKING state', () => {
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + 10,
    y: 5 * GRID.panelSize + 10,
    facing: 0,
    hp: 1,
    targetCx: 5,
    targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
  };
  const after = stepCrawler(c, 0.1, GRID, makeCtx([]));
  assert.equal(after.ai, CrawlerAIState.ATTACKING);
  assert.equal(after.x, c.x, 'no players → no movement');
  assert.equal(after.y, c.y);
});

test('crawler step does not mutate tile HP directly (Room aggregates weight)', () => {
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0,
    hp: 1,
    targetCx: 5,
    targetCy: 5,
    ai: CrawlerAIState.ATTACKING,
  };
  const ctx = makeCtx([makePlayer(10 * GRID.panelSize, 5 * GRID.panelSize)]);
  const before = ctx.tiles.l1Hp[indexOf(GRID.cols, 5, 5)];
  stepCrawler(c, 1.0, GRID, ctx);
  assert.equal(ctx.tiles.l1Hp[indexOf(GRID.cols, 5, 5)], before);
});
