import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateTiles, indexOf } from '../tiles.js';
import {
  stepCrawler,
  CrawlerTaskKind,
  type CrawlerStepContext,
  type CrawlerTask,
} from './crawler.js';
import { CrawlerAIState, type CrawlerState, type GridDef } from '../types.js';

const GRID = { cols: 18, rows: 12, panelSize: 64 };

function makeCtx(): CrawlerStepContext {
  return { tiles: allocateTiles(GRID.cols, GRID.rows) };
}

test('stepCrawler CHASE walks toward target at full speed', () => {
  const c: CrawlerState = {
    id: 1,
    x: 1 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0, hp: 1, targetCx: 1, targetCy: 5,
    ai: CrawlerAIState.APPROACHING,
    windUpInS: 0,
  };
  const task: CrawlerTask = {
    kind: CrawlerTaskKind.CHASE_PLAYER,
    targetX: 10 * GRID.panelSize,
    targetY: 5 * GRID.panelSize + GRID.panelSize / 2,
  };
  const after = stepCrawler(c, task, 0.1, GRID, makeCtx());
  assert.equal(after.ai, CrawlerAIState.APPROACHING);
  assert.ok(after.x > c.x, 'bug must advance toward chase target');
});

test('CHASE arrival within meleeGap transitions to WIND_UP, not ATTACKING', () => {
  const c: CrawlerState = {
    id: 1, x: 332, y: 320, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0, ai: CrawlerAIState.APPROACHING,
    windUpInS: 0,
  };
  const task: CrawlerTask = {
    kind: CrawlerTaskKind.CHASE_PLAYER, targetX: 320, targetY: 320,
  };
  const grid: GridDef = { cols: 10, rows: 10, panelSize: 64 };
  const next = stepCrawler(c, task, 0.016, grid, { tiles: allocateTiles(10, 10) });
  assert.equal(next.ai, CrawlerAIState.WIND_UP);
  assert.ok(Math.abs(next.windUpInS - 0.6) < 0.01,
    `expected windUpInS≈0.6, got ${next.windUpInS}`);
});

test('stepCrawler ATTACK_TILE freezes the bug on the specified tile', () => {
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + 10,
    y: 5 * GRID.panelSize + 10,
    facing: 0, hp: 1, targetCx: 0, targetCy: 0,
    ai: CrawlerAIState.APPROACHING,
    windUpInS: 0,
  };
  const task: CrawlerTask = { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: 5, targetCy: 5 };
  const after = stepCrawler(c, task, 0.1, GRID, makeCtx());
  assert.equal(after.ai, CrawlerAIState.ATTACKING);
  assert.equal(after.x, c.x, 'bug must not move during ATTACK_TILE');
  assert.equal(after.targetCx, 5);
  assert.equal(after.targetCy, 5);
});

test('stepCrawler does not mutate tile HP (Room aggregates weight)', () => {
  const c: CrawlerState = {
    id: 1,
    x: 5 * GRID.panelSize + GRID.panelSize / 2,
    y: 5 * GRID.panelSize + GRID.panelSize / 2,
    facing: 0, hp: 1, targetCx: 5, targetCy: 5,
    ai: CrawlerAIState.ATTACKING,
    windUpInS: 0,
  };
  const ctx = makeCtx();
  const before = ctx.tiles.l1Hp[indexOf(GRID.cols, 5, 5)];
  stepCrawler(c, { kind: CrawlerTaskKind.ATTACK_TILE, targetCx: 5, targetCy: 5 }, 1.0, GRID, ctx);
  assert.equal(ctx.tiles.l1Hp[indexOf(GRID.cols, 5, 5)], before);
});
