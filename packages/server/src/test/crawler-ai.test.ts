import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MITE_PROFILE,
  allocateTiles,
  type CrawlerState,
  type PlayerState,
} from '@gridforce/shared';
import { CrawlerAiManager } from '../CrawlerAi.js';

const GRID = { cols: 10, rows: 10, panelSize: 64 };

function newBug(id: number, x: number, y: number): CrawlerState {
  return {
    id, x, y, facing: 0, hp: 1,
    targetCx: 0, targetCy: 0,
    ai: 0, windUpInS: 0,
  };
}
function newPlayer(id: number, x: number, y: number): PlayerState {
  return {
    id, x, y, facing: 0, facingCursorRad: 0,
    panelJumpCooldownS: 0, stateSeq: 0,
    name: '', ready: true,
    carbon: 0, shockCooldownS: 0, repairProgressS: 0, shockHeldS: 0,
  };
}

test('phase: bug starts CALM with no players nearby', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'CALM');
});

test('phase: player inside detectionRadius flips CALM → ENGAGED', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  const player = newPlayer(0, 420, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
});

test('phase: player leaves detection — ENGAGED → CALM after engagedDecayS', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [newPlayer(0, 420, 320)], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
  for (let t = 0; t < 9; t += 0.5) {
    mgr.decide(bug, 0.5, [], [bug], tiles, GRID);
  }
  assert.equal(mgr.getPhase(1), 'CALM');
});

test('phase: damage taken flips CALM → ENGAGED and seeds INVESTIGATE target', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'CALM');
  mgr.onDamageTaken(1, 1, 600, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
  const target = mgr.getInvestigateTarget(1);
  assert.ok(target);
  assert.equal(target!.x, 600);
  assert.equal(target!.y, 320);
});

test('eligibility: SEEK_PLAYER eligible only in ENGAGED phase with a player', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  assert.ok(!mgr.isTaskEligible(1, 'SEEK_PLAYER', [], tiles, GRID));
  const player = newPlayer(0, 420, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.ok(mgr.isTaskEligible(1, 'SEEK_PLAYER', [player], tiles, GRID));
});

test('eligibility: ATTACK_PLAYER eligible only at meleeGapPx', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  let player = newPlayer(0, 400, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.ok(!mgr.isTaskEligible(1, 'ATTACK_PLAYER', [player], tiles, GRID));
  player = newPlayer(0, 340, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.ok(mgr.isTaskEligible(1, 'ATTACK_PLAYER', [player], tiles, GRID));
});

test('score: ATTACK_TILE on a healthy panel returns ~panelBase', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  const score = mgr.scoreTask(1, 'ATTACK_TILE', [], [bug], tiles, GRID);
  assert.ok(Math.abs(score - 5) < 0.001);
});

test('phase: re-detection mid-decay resets engagedIdleS', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  const player = newPlayer(0, 420, 320);

  // Enter ENGAGED.
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');

  // Let engagedIdleS partially accumulate (5 s of no player).
  for (let t = 0; t < 5; t += 0.5) {
    mgr.decide(bug, 0.5, [], [bug], tiles, GRID);
  }
  // Still ENGAGED (5 s < 8 s engagedDecayS).
  assert.equal(mgr.getPhase(1), 'ENGAGED');

  // Re-expose the player for one tick — should reset engagedIdleS.
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');

  // Player gone again. Wait full 8+ s. Should still need the full
  // engagedDecayS window starting from now.
  for (let t = 0; t < 7.5; t += 0.5) {
    mgr.decide(bug, 0.5, [], [bug], tiles, GRID);
  }
  // 7.5 s elapsed since reset — should STILL be ENGAGED (less than 8).
  assert.equal(mgr.getPhase(1), 'ENGAGED');

  // One more second pushes past the threshold.
  for (let t = 0; t < 1.5; t += 0.5) {
    mgr.decide(bug, 0.5, [], [bug], tiles, GRID);
  }
  assert.equal(mgr.getPhase(1), 'CALM');
});
