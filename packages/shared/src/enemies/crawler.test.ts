import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CrawlerAIState,
  type CrawlerState,
  type GridDef,
} from '../types.js';
import {
  PanelState,
  allLive,
  indexOf,
} from '../panels.js';
import {
  PANEL_ATTACK_TO_DAMAGE_S,
  PANEL_ATTACK_TO_BREAK_S,
  CRAWLER_MOVE_SPEED,
} from '../constants.js';
import { stepCrawler, type CrawlerStepContext } from './crawler.js';

const grid: GridDef = { cols: 18, rows: 12, panelSize: 64 };

function freshContext(): CrawlerStepContext {
  return {
    panels: allLive(grid.cols, grid.rows),
    attackTimers: new Map<number, number>(),
    cityHpDelta: 0,
  };
}

test('approaching crawler walks toward target panel', () => {
  const c: CrawlerState = {
    id: 1, x: grid.cols * grid.panelSize / 2, y: 10,
    facing: Math.PI / 2, hp: 1,
    targetCx: 9, targetCy: 0, ai: CrawlerAIState.APPROACHING,
  };
  const ctx = freshContext();
  const dt = 1 / 30;
  const next = stepCrawler(c, dt, grid, ctx);
  const distMoved = Math.hypot(next.x - c.x, next.y - c.y);
  assert.ok(distMoved > 0, 'crawler should have moved');
  assert.ok(distMoved <= CRAWLER_MOVE_SPEED * dt + 0.01, 'no faster than speed');
});

test('attacking crawler degrades LIVE -> DAMAGED after attack-time-to-damage', () => {
  const ctx = freshContext();
  const cx = 5;
  const cy = 5;
  const c: CrawlerState = {
    id: 1,
    x: cx * grid.panelSize + grid.panelSize / 2,
    y: cy * grid.panelSize + grid.panelSize / 2,
    facing: 0, hp: 1,
    targetCx: cx, targetCy: cy, ai: CrawlerAIState.ATTACKING,
  };
  let cur = c;
  const dt = 1 / 30;
  const ticks = Math.ceil((PANEL_ATTACK_TO_DAMAGE_S + 0.05) / dt);
  for (let i = 0; i < ticks; i++) cur = stepCrawler(cur, dt, grid, ctx);
  const panelIdx = indexOf(grid.cols, cx, cy);
  assert.equal(ctx.panels[panelIdx], PanelState.DAMAGED);
});

test('attacking crawler degrades DAMAGED -> BROKEN after another attack window', () => {
  const ctx = freshContext();
  const cx = 5;
  const cy = 5;
  ctx.panels[indexOf(grid.cols, cx, cy)] = PanelState.DAMAGED;
  const c: CrawlerState = {
    id: 1,
    x: cx * grid.panelSize + grid.panelSize / 2,
    y: cy * grid.panelSize + grid.panelSize / 2,
    facing: 0, hp: 1,
    targetCx: cx, targetCy: cy, ai: CrawlerAIState.ATTACKING,
  };
  let cur = c;
  const dt = 1 / 30;
  const ticks = Math.ceil((PANEL_ATTACK_TO_BREAK_S + 0.05) / dt);
  for (let i = 0; i < ticks; i++) cur = stepCrawler(cur, dt, grid, ctx);
  assert.equal(ctx.panels[indexOf(grid.cols, cx, cy)], PanelState.BROKEN);
});

test('crawler transitioning through broken tile moves in facing direction', () => {
  const ctx = freshContext();
  const cx = 5;
  const cy = 0; // top row
  ctx.panels[indexOf(grid.cols, cx, cy)] = PanelState.BROKEN;
  // Facing downward (+y in screen coords) — crawler came from top edge,
  // walking south through the hole.
  const c: CrawlerState = {
    id: 1,
    x: cx * grid.panelSize + grid.panelSize / 2,
    y: cy * grid.panelSize + grid.panelSize / 2,
    facing: Math.PI / 2, hp: 1,
    targetCx: cx, targetCy: cy, ai: CrawlerAIState.TRANSITING,
  };
  const next = stepCrawler(c, 1 / 30, grid, ctx);
  assert.ok(next.y > c.y, `expected y to increase (move south), was ${c.y} now ${next.y}`);
});
