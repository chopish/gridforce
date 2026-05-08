// Pre-game lobby selectables. Phase 0 has no actual gameplay variation
// behind these — the lists exist so the lobby UI is real and the wire
// format already carries the fields we'll branch on once levels and
// difficulty curves ship.

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

export interface LevelDef {
  id: string;
  name: string;
  // Free-text blurb the lobby UI shows under the level name.
  description: string;
}

// Phase 0 ships with one level — the empty test grid. The wire format
// already carries levelId so adding more is a purely client+server data
// change with no schema bump.
export const LEVELS: readonly LevelDef[] = [
  { id: 'test-grid', name: 'Test Grid', description: 'Empty grid for movement and dash testing.' },
];

export const DEFAULT_LEVEL_ID = LEVELS[0]!.id;
export const DEFAULT_DIFFICULTY: DifficultyValue = Difficulty.Normal;

export function isValidLevelId(id: string): boolean {
  for (const lvl of LEVELS) if (lvl.id === id) return true;
  return false;
}
