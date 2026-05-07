export interface HudState {
  tick: number;
  rttMs: number;
  predictionErrorPx: number;
  reconcileRewindTicks: number;
  pendingInputs: number;
  fps: number;
}

export class DebugHud {
  private el: HTMLElement;
  private lastFrame = performance.now();
  private fps = 0;

  constructor() {
    const el = document.getElementById('hud');
    if (!el) throw new Error('#hud element missing in index.html');
    this.el = el;
  }

  show(): void {
    this.el.removeAttribute('hidden');
  }

  hide(): void {
    this.el.setAttribute('hidden', '');
  }

  tick(): void {
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    if (dt > 0) {
      const inst = 1000 / dt;
      // Low-pass smoothed FPS
      this.fps = this.fps === 0 ? inst : this.fps * 0.9 + inst * 0.1;
    }
  }

  update(s: Omit<HudState, 'fps'>): void {
    const lines = [
      `tick      ${s.tick}`,
      `rtt       ${s.rttMs.toFixed(0)} ms`,
      `predErr   ${s.predictionErrorPx.toFixed(2)} px`,
      `rollback  ${s.reconcileRewindTicks} ticks`,
      `pending   ${s.pendingInputs}`,
      `fps       ${this.fps.toFixed(0)}`,
    ];
    this.el.textContent = lines.join('\n');
  }
}
