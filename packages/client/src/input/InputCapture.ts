import type { PlayerInput } from '@gridforce/shared';

// Captures keyboard input. Calls .sample(tick) once per sim tick to produce
// a PlayerInput record for that tick.
export class InputCapture {
  private down = new Set<string>();
  private dashLatched = false;

  attach(target: HTMLElement | Window = window): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.dashLatched = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.down.delete(e.code);
    };
    const onBlur = () => this.down.clear();

    target.addEventListener('keydown', onKeyDown as EventListener);
    target.addEventListener('keyup', onKeyUp as EventListener);
    target.addEventListener('blur', onBlur as EventListener);

    return () => {
      target.removeEventListener('keydown', onKeyDown as EventListener);
      target.removeEventListener('keyup', onKeyUp as EventListener);
      target.removeEventListener('blur', onBlur as EventListener);
    };
  }

  // Forget all currently-held keys and any latched dash. Called when the window
  // loses focus or the tab is hidden — keyup events are unreliable across those
  // transitions, so the safe default is "no input."
  clear(): void {
    this.down.clear();
    this.dashLatched = false;
  }

  sample(tick: number): PlayerInput {
    let mx = 0;
    let my = 0;
    if (this.down.has('KeyA') || this.down.has('ArrowLeft')) mx -= 1;
    if (this.down.has('KeyD') || this.down.has('ArrowRight')) mx += 1;
    if (this.down.has('KeyW') || this.down.has('ArrowUp')) my -= 1;
    if (this.down.has('KeyS') || this.down.has('ArrowDown')) my += 1;

    const dash = this.dashLatched;
    this.dashLatched = false; // edge-triggered: dash fires once per press

    return { tick, mx, my, dash };
  }
}
