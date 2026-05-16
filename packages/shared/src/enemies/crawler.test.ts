import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateTiles, indexOf } from '../tiles.js';
import { stepCrawler, type CrawlerStepContext } from './crawler.js';
import { CrawlerAIState, type CrawlerState } from '../types.js';

const GRID = { cols: 18, rows: 12, panelSize: 64 };

function makeCtx(): CrawlerStepContext {
  return { tiles: allocateTiles(GRID.cols, GRID.rows) };
}

test('APPROACHING moves toward target until within half a panel', () => {
  const c: CrawlerState = {
    id: 1, x: 0, y: 32, facing: 0, hp: 1,
    targetCx: 5, targetCy: 0, ai: CrawlerAIState.APPROACHING,
  };
  const ctx = makeCtx();
  const after = stepCrawler(c, 0.1, GRID, ctx);
  assert.ok(after.x > 0);
  assert.equal(after.ai, CrawlerAIState.APPROACHING);
});

test('ATTACKING transitions to TRANSITING when its tile is a passage', () => {
  const c: CrawlerState = {
    id: 1, x: 0, y: 0, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.ATTACKING,
  };
  const ctx = makeCtx();
  const idx = indexOf(GRID.cols, 0, 0);
  ctx.tiles.l1Hp[idx] = 0;
  ctx.tiles.l0Hp[idx] = 0;
  const after = stepCrawler(c, 0.1, GRID, ctx);
  assert.equal(after.ai, CrawlerAIState.TRANSITING);
});

test('TRANSITING walks past the world edge and gets hp=0', () => {
  const c: CrawlerState = {
    id: 1, x: 5, y: 32, facing: Math.PI, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.TRANSITING,
  };
  const ctx = makeCtx();
  const after = stepCrawler(c, 1.0, GRID, ctx);
  assert.equal(after.hp, 0);
  assert.ok(after.x < 0);
});

test('ATTACKING crawler does not mutate tile HP directly (weight handled by Room)', () => {
  const c: CrawlerState = {
    id: 1, x: 0, y: 0, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.ATTACKING,
  };
  const ctx = makeCtx();
  const idx = indexOf(GRID.cols, 0, 0);
  const beforeHp = ctx.tiles.l1Hp[idx];
  stepCrawler(c, 1.0, GRID, ctx);
  assert.equal(ctx.tiles.l1Hp[idx], beforeHp);
});
