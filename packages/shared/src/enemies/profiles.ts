import { TaskKind, type TaskKindValue } from './taskTypes.js';

// All per-enemy tuning lives here. v1 has one profile (mite); future
// enemy types are additional records following the same shape.
export interface EnemyProfile {
  readonly id: string;

  // ─── Detection ───────────────────────────────────────────────────────
  readonly detectionRadiusPx: number;
  readonly searchRadiusMult: number;
  readonly engagedDecayS: number;

  // ─── Movement ────────────────────────────────────────────────────────
  readonly baseSpeedPx: number;
  readonly passageSpeedMult: number;

  // ─── Combat ──────────────────────────────────────────────────────────
  readonly meleeGapPx: number;
  readonly windUpDurS: number;
  readonly recoveryDurS: number;
  readonly staggerThresholdHp: number;
  readonly staggerWindowS: number;

  // ─── Tile interest ───────────────────────────────────────────────────
  readonly panelBase: number;
  readonly panelDamageScale: number;
  readonly domeBase: number;
  readonly domeDamageScale: number;
  readonly seekTileRadiusPx: number;

  // ─── Crowd / swarm-cohesion ──────────────────────────────────────────
  readonly crowdRadiusPx: number;           // peer-count radius for crowdPenalty

  // ─── Task vocabulary ─────────────────────────────────────────────────
  readonly taskLibrary: readonly TaskKindValue[];
  readonly taskWeights: Readonly<Record<TaskKindValue, number>>;
  readonly startTask: TaskKindValue;

  // ─── Swarm AI scaffold (mite default: mild propagation) ─────────────
  readonly alertPropagationRadiusPx: number;
  readonly alertBonusMult: number;
  readonly alertBonusDurS: number;
  readonly investigateStaleS: number;
}

export const MITE_PROFILE = {
  id: 'mite',

  detectionRadiusPx: 160,
  searchRadiusMult: 1.6,
  engagedDecayS: 8,

  baseSpeedPx: 80,
  passageSpeedMult: 1.3,

  meleeGapPx: 30,
  windUpDurS: 0.6,
  recoveryDurS: 0.4,
  staggerThresholdHp: 2,
  staggerWindowS: 0.5,

  panelBase: 5,
  panelDamageScale: 15,
  domeBase: 25,
  domeDamageScale: 35,
  seekTileRadiusPx: 192,

  crowdRadiusPx: 128,

  taskLibrary: [
    TaskKind.SEEK_PLAYER,
    TaskKind.ATTACK_PLAYER,
    TaskKind.SEEK_TILE,
    TaskKind.ATTACK_TILE,
    TaskKind.SEARCH,
    TaskKind.INVESTIGATE,
    TaskKind.IDLE,
  ],
  taskWeights: {
    [TaskKind.SEEK_PLAYER]:   1.0,
    [TaskKind.ATTACK_PLAYER]: 1.0,
    [TaskKind.SEEK_TILE]:     0.3,
    [TaskKind.ATTACK_TILE]:   0.5,
    [TaskKind.SEARCH]:        0.6,
    [TaskKind.INVESTIGATE]:   0.8,
    [TaskKind.IDLE]:          0.1,
  },
  startTask: TaskKind.SEEK_PLAYER,

  alertPropagationRadiusPx: 128,
  alertBonusMult: 1.3,
  alertBonusDurS: 2.0,
  investigateStaleS: 10,
} as const satisfies EnemyProfile;
