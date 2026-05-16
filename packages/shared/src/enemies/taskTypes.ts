// V1 task vocabulary for the priority AI. Each task is an "intent" the AI
// manager assigns to a bug; the executor (stepCrawler) then drives the
// physical state machine (CrawlerAIState) toward that intent. See
// docs/superpowers/specs/2026-05-16-c2-task-vocabulary-and-attack-player-design.md
// for the per-task eligibility and scoring spec.
export const TaskKind = {
  SEEK_PLAYER:   'SEEK_PLAYER',
  ATTACK_PLAYER: 'ATTACK_PLAYER',
  SEEK_TILE:     'SEEK_TILE',
  ATTACK_TILE:   'ATTACK_TILE',
  SEARCH:        'SEARCH',
  INVESTIGATE:   'INVESTIGATE',
  IDLE:          'IDLE',
} as const;
export type TaskKindValue = (typeof TaskKind)[keyof typeof TaskKind];

export type Task =
  | { kind: typeof TaskKind.SEEK_PLAYER; targetX: number; targetY: number }
  | { kind: typeof TaskKind.ATTACK_PLAYER; targetPlayerId: number }
  | { kind: typeof TaskKind.SEEK_TILE; targetCx: number; targetCy: number }
  | { kind: typeof TaskKind.ATTACK_TILE; targetCx: number; targetCy: number }
  | { kind: typeof TaskKind.SEARCH; wanderTargetX: number; wanderTargetY: number }
  | { kind: typeof TaskKind.INVESTIGATE; targetX: number; targetY: number }
  | { kind: typeof TaskKind.IDLE };
