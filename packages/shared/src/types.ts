export type PanelState = 'LIVE' | 'DAMAGED' | 'BROKEN';

export interface Panel {
  state: PanelState;
  hp: number;
}

export interface Grid {
  width: number;
  height: number;
  panels: Panel[];
}

export interface PlayerInput {
  tick: number;
  mx: number;
  my: number;
  dash: boolean;
}

export interface Player {
  id: string;
  name: string;
  isBot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashTimer: number;
  dashCooldown: number;
  facing: number;
}

export interface WorldState {
  tick: number;
  grid: Grid;
  players: Player[];
  rngState: number;
}

export type PlayerId = string;
