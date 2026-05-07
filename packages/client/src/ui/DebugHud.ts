import type { PredictionDiagnostics } from '../sim/PredictedWorld.js';
import type { SocketStatus } from '../net/Socket.js';

export interface HudFrame {
  fps: number;
  socket: SocketStatus;
  prediction: PredictionDiagnostics;
  remoteDelayMs: number;
  netSimName: string;
}

export class DebugHud {
  private root: HTMLElement;
  private netSimEl: HTMLElement | null;

  constructor() {
    const el = document.getElementById('hud');
    if (!el) throw new Error('#hud element missing');
    el.hidden = false;
    this.root = el;
    this.netSimEl = document.getElementById('netsim');
    if (this.netSimEl) this.netSimEl.hidden = false;
  }

  update(f: HudFrame): void {
    const lines = [
      `fps    ${f.fps.toFixed(0)}`,
      `state  ${f.socket.state}`,
      `rtt    ${f.socket.rttMs.toFixed(0)} ms`,
      `tick   pred=${f.prediction.predictedTick}  srv=${f.prediction.serverTick}`,
      `pend   ${f.prediction.pendingInputs}`,
      `replay ${f.prediction.lastReplayInputs}`,
      `err    ${f.prediction.lastPredictionErrorPx.toFixed(1)} px`,
      `snaps  hard=${f.prediction.hardSnaps}`,
      `interp ${f.remoteDelayMs.toFixed(0)} ms`,
    ];
    this.root.textContent = lines.join('\n');
    if (this.netSimEl) {
      this.netSimEl.textContent = `netsim: ${f.netSimName} (press F to cycle)`;
    }
  }
}
