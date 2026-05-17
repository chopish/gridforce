import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MITE_PROFILE,
  TaskKind,
  allocateTiles,
  indexOf,
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

test('selection: lone mite in ENGAGED with a nearby pilot picks SEEK_PLAYER >90% of rolls', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const player = newPlayer(0, 420, 320);
  const bug = newBug(1, 320, 320);

  let chases = 0;
  for (let i = 0; i < 200; i++) {
    mgr.forceReroll(1);
    const task = mgr.decideTask(bug, 0.016, [player], [bug], tiles, GRID);
    if (task === 'SEEK_PLAYER') chases++;
  }
  assert.ok(chases > 180, `expected >180 chases, got ${chases}`);
});

test('selection: lone mite in CALM near no damaged tiles favours SEARCH', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);

  const counts: Record<string, number> = {};
  for (let i = 0; i < 200; i++) {
    mgr.forceReroll(1);
    const task = mgr.decideTask(bug, 0.016, [], [bug], tiles, GRID);
    counts[task] = (counts[task] ?? 0) + 1;
  }
  assert.ok((counts['SEARCH'] ?? 0) > (counts['IDLE'] ?? 0));
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

test('wind-up: windUpInS counts down each tick', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 332, 320);
  const player = newPlayer(0, 320, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  const first = mgr.getInternalAi(1)!;
  const wind1 = first.windUpInS;
  assert.ok(wind1 > 0, `expected wind1 > 0; got ${wind1}`);

  mgr.decide(bug, 0.1, [player], [bug], tiles, GRID);
  const wind2 = mgr.getInternalAi(1)!.windUpInS;
  assert.ok(wind2 < wind1, `expected wind2 < wind1; got wind2=${wind2}, wind1=${wind1}`);
});

test('wind-up: timer expiring fires SWING and transitions to RECOVERY', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 332, 320);
  const player = newPlayer(0, 320, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  // Fast-forward through the wind-up (default windUpDurS=0.6).
  for (let t = 0; t < 1.0; t += 0.05) {
    mgr.decide(bug, 0.05, [player], [bug], tiles, GRID);
  }
  const ai = mgr.getInternalAi(1)!;
  assert.ok(ai.recoveryInS > 0,
    `bug should be in RECOVERY; recoveryInS=${ai.recoveryInS}, windUpInS=${ai.windUpInS}`);
});

test('SEEK_TILE: picks the most damaged tile within seekTileRadiusPx and walks toward it', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  // Damage tile (7, 5) significantly; leave others healthy.
  tiles.l1Hp[indexOf(GRID.cols, 7, 5)] = 10;
  const bug = newBug(1, 320, 320); // tile (5, 5)
  // Populate lastBugPos so forceTask can seed from a known position.
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  // Force SEEK_TILE with bookkeeping — seeds taskTargetCx/Cy from the
  // best damaged tile in radius via findBestSeekTile.
  mgr.forceTask(1, TaskKind.SEEK_TILE, tiles, GRID);
  const ai = mgr.getInternalAi(1)!;
  assert.equal(ai.taskTargetCx, 7);
  assert.equal(ai.taskTargetCy, 5);
});

test('stagger: damage during wind-up accumulates; threshold cancels swing', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 332, 320);
  const player = newPlayer(0, 320, 320);
  // Enter WIND_UP.
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  const ai0 = mgr.getInternalAi(1)!;
  assert.ok(ai0.windUpInS > 0);

  // Hit the bug for 2 hp (= staggerThresholdHp). Wind-up should cancel.
  mgr.onDamageTaken(1, 2, 0, 0);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  const ai1 = mgr.getInternalAi(1)!;
  // No swing should have fired on the cancellation path.
  assert.equal(ai1.swingFiredThisTick, false);
  // Bug should be in RECOVERY.
  assert.ok(ai1.recoveryInS > 0, `bug should be in RECOVERY; recoveryInS=${ai1.recoveryInS}`);
});

test('SEARCH: bug walks toward a random wander target', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  // Force SEARCH (rich helper from T13: runs entry bookkeeping).
  mgr.forceTask(1, TaskKind.SEARCH, tiles, GRID);
  const ai = mgr.getInternalAi(1)!;
  // A wander target should be picked (non-zero).
  assert.ok(ai.taskTargetX !== 0 || ai.taskTargetY !== 0,
    `expected wander target seeded; got (${ai.taskTargetX},${ai.taskTargetY})`);
});

test('SEARCH: phase check sees pilots from detectionRadius × searchRadiusMult', () => {
  const mgr = new CrawlerAiManager();
  mgr.registerCrawler(1, MITE_PROFILE);
  const tiles = allocateTiles(GRID.cols, GRID.rows);
  const bug = newBug(1, 320, 320);
  // First decide to populate lastBugPos.
  mgr.decide(bug, 0.016, [], [bug], tiles, GRID);
  // Force SEARCH (widens detection by searchRadiusMult).
  mgr.forceTask(1, TaskKind.SEARCH, tiles, GRID);
  // Pilot at 220 px — outside base 160 detection radius, inside
  // widened 160 × 1.6 = 256 radius.
  const player = newPlayer(0, 540, 320);
  mgr.decide(bug, 0.016, [player], [bug], tiles, GRID);
  assert.equal(mgr.getPhase(1), 'ENGAGED');
});
