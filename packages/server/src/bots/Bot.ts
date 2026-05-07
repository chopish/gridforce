import type { PlayerInput, WorldState } from '@gridforce/shared';

export interface Bot {
  id: string;
  name: string;
  getInput(state: WorldState, tick: number): PlayerInput;
}
