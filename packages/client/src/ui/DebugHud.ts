import type { PredictionDiagnostics } from '../sim/PredictedWorld.js';
import type { SocketStatus } from '../net/Socket.js';

export interface HudFrame {
  fps: number;
  socket: SocketStatus;
  prediction: PredictionDiagnostics;
  remoteDelayMs: number;
  netSimName: string;
  npcCount: number;
  isHost: boolean;
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
    const lead = f.prediction.predictedTick - f.prediction.serverTick;
    const lines = [
      `fps     ${f.fps.toFixed(0)}`,
      `state   ${f.socket.state}`,
      `rtt     ${f.socket.rttMs.toFixed(0)} ms`,
      `tick    pred=${f.prediction.predictedTick}  srv=${f.prediction.serverTick}  lead=${lead}`,
      `pend    ${f.prediction.pendingInputs}`,
      `replay  ${f.prediction.lastReplayInputs}`,
      `err     last=${f.prediction.lastPredictionErrorPx.toFixed(1)} px  max=${f.prediction.recentMaxErrorPx.toFixed(1)} px`,
      `corr    ${f.prediction.correctionMagnitudePx.toFixed(1)} px (avg ${f.prediction.correctionEwmaPx.toFixed(1)})`,
      `recon   smooth=${f.prediction.smoothCorrections}  hard=${f.prediction.hardSnaps}`,
      `interp  ${f.remoteDelayMs.toFixed(0)} ms`,
      `xport   ${f.socket.dataTransport}`,
      `host    ${f.isHost ? 'yes' : 'no (NPC keys ignored)'}`,
      `npcs    ${f.npcCount} (N +20  J +100  K clear)`,
    ];
    this.root.textContent = lines.join('\n');
    if (this.netSimEl) {
      this.netSimEl.textContent = `netsim: ${f.netSimName} (press F to cycle)`;
    }
  }
}
