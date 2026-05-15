// Run / Stage / Phase definitions and registries.
//
// Outer container: a Run is an ordered sequence of stages (the whole
// playthrough). Each Stage is one Smash-TV-style screen, owning its own
// grid + ordered Phase list. Phases are sub-states inside a stage; a phase
// either auto-advances on its durationS timer, or is event-driven
// (durationS = null) and advanced explicitly by gameplay code via
// Room.advancePhase().
//
// Bootstrap content here is `test-run` → `test-grid` → single open-ended
// 'active' phase: the room behaves exactly as it did pre-stages (no
// auto-advance, players move and dash forever).
//
// Difficulty constants live here too — they previously lived in lobby.ts
// (now deleted) and the wire format is unchanged.

import { createDefaultGrid } from './grid.js';
import type { GridDef } from './types.js';

// --- Difficulty (relocated from lobby.ts; wire-identical) ---

export const Difficulty = {
  Easy: 0,
  Normal: 1,
  Hard: 2,
} as const;
export type DifficultyValue = (typeof Difficulty)[keyof typeof Difficulty];

export const DIFFICULTY_NAMES: Record<DifficultyValue, string> = {
  [Difficulty.Easy]: 'easy',
  [Difficulty.Normal]: 'normal',
  [Difficulty.Hard]: 'hard',
};

export function isValidDifficulty(v: number): v is DifficultyValue {
  return v === Difficulty.Easy || v === Difficulty.Normal || v === Difficulty.Hard;
}

export const DEFAULT_DIFFICULTY: DifficultyValue = Difficulty.Normal;

// --- Run / Stage / Phase ---

export interface PhaseDef {
  id: string;
  displayName: string;
  // null = event-driven; gameplay code calls Room.advancePhase() to leave.
  durationS: number | null;
}

export interface StageDef {
  id: string;
  displayName: string;
  grid: GridDef;
  // Non-empty. Stage always starts at phaseSequence[0].
  phaseSequence: PhaseDef[];
  // Free-text key for visual theming downstream of sub-spec 1.
  theme?: string;
}

export interface RunDef {
  id: string;
  displayName: string;
  // Non-empty. Ids reference STAGES.
  stageSequence: string[];
}

// Phase 0 bootstrap content. One stage, one open-ended phase — the room
// behaves identically to the pre-stages prototype.
export const STAGES: Record<string, StageDef> = {
  'test-grid': {
    id: 'test-grid',
    displayName: 'Test Grid',
    grid: createDefaultGrid(),
    phaseSequence: [{ id: 'active', displayName: 'Active', durationS: null }],
  },
  'large-grid': {
    id: 'large-grid',
    displayName: 'Large Grid',
    grid: { cols: 36, rows: 24, panelSize: 64 },
    phaseSequence: [{ id: 'active', displayName: 'Active', durationS: null }],
  },
};

export const RUNS: Record<string, RunDef> = {
  'test-run': {
    id: 'test-run',
    displayName: 'Test Run',
    stageSequence: ['test-grid'],
  },
  'large-run': {
    id: 'large-run',
    displayName: 'Large Run',
    stageSequence: ['large-grid'],
  },
};

export const DEFAULT_RUN_ID = 'test-run';

export function getStage(id: string): StageDef {
  const s = STAGES[id];
  if (!s) throw new Error(`unknown stage id: ${id}`);
  return s;
}

export function getRun(id: string): RunDef {
  const r = RUNS[id];
  if (!r) throw new Error(`unknown run id: ${id}`);
  return r;
}

export function getRunOrDefault(id: string): RunDef {
  return RUNS[id] ?? RUNS[DEFAULT_RUN_ID]!;
}

export function isValidRunId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUNS, id);
}
