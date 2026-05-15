// Stage / phase HUD. Shown during 'playing': a top-of-viewport pill with
// "Stage i+1/total — Phase Name" and an optional countdown bar when the
// current phase is timer-driven (durationS != null). On 'run-end' the
// pill is replaced with a full-screen "Run Complete" panel. In 'lobby',
// nothing is shown (the LobbyOverlay owns the screen).
//
// Stays passive: caller pushes state via update() each frame, signature
// compare gates DOM mutations so it's cheap to call at 60 fps.

import type { PhaseDef, RoomPhase, StageDef } from '@gridforce/shared';

export interface StageHudState {
  phase: RoomPhase;
  stage: StageDef;
  phaseDef: PhaseDef;
  stageIndex: number;
  totalStages: number;
  phaseElapsedS: number;
}

export class StageHud {
  private pill: HTMLDivElement;
  private stageLabel: HTMLSpanElement;
  private phaseLabel: HTMLSpanElement;
  private timerBar: HTMLDivElement;
  private timerFill: HTMLDivElement;
  private runEnd: HTMLDivElement;
  private lastSig = '';

  constructor() {
    this.applyChrome();

    this.pill = document.createElement('div');
    this.pill.id = 'stage-hud';
    this.pill.style.display = 'none';

    this.stageLabel = document.createElement('span');
    this.stageLabel.className = 'sh-stage';
    this.pill.appendChild(this.stageLabel);

    const sep = document.createElement('span');
    sep.className = 'sh-sep';
    sep.textContent = '—';
    this.pill.appendChild(sep);

    this.phaseLabel = document.createElement('span');
    this.phaseLabel.className = 'sh-phase';
    this.pill.appendChild(this.phaseLabel);

    this.timerBar = document.createElement('div');
    this.timerBar.className = 'sh-timer';
    this.timerBar.style.display = 'none';
    this.timerFill = document.createElement('div');
    this.timerFill.className = 'sh-timer-fill';
    this.timerBar.appendChild(this.timerFill);
    this.pill.appendChild(this.timerBar);

    document.body.appendChild(this.pill);

    this.runEnd = document.createElement('div');
    this.runEnd.id = 'stage-hud-runend';
    this.runEnd.style.display = 'none';
    this.runEnd.innerHTML = `
      <div class="sh-runend-card">
        <div class="sh-runend-title">RUN COMPLETE</div>
        <div class="sh-runend-sub">the framework reached its terminal state</div>
      </div>
    `;
    document.body.appendChild(this.runEnd);
  }

  destroy(): void {
    this.pill.remove();
    this.runEnd.remove();
  }

  update(s: StageHudState): void {
    if (s.phase === 'lobby') {
      this.pill.style.display = 'none';
      this.runEnd.style.display = 'none';
      return;
    }
    if (s.phase === 'run-end') {
      this.pill.style.display = 'none';
      this.runEnd.style.display = '';
      return;
    }
    // 'playing'
    this.runEnd.style.display = 'none';
    this.pill.style.display = '';

    // Signature gate. Timer fill width is derived continuously so we
    // include it in the sig only at low resolution.
    const dur = s.phaseDef.durationS;
    const frac = dur !== null && dur > 0 ? Math.min(1, s.phaseElapsedS / dur) : -1;
    const fracBucket = frac < 0 ? 'none' : Math.round(frac * 200).toString();
    const sig = [
      s.stageIndex,
      s.totalStages,
      s.stage.id,
      s.phaseDef.id,
      s.phaseDef.displayName,
      fracBucket,
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.stageLabel.textContent = `Stage ${s.stageIndex + 1}/${s.totalStages}`;
    this.phaseLabel.textContent = s.phaseDef.displayName;
    if (frac < 0) {
      this.timerBar.style.display = 'none';
    } else {
      this.timerBar.style.display = '';
      this.timerFill.style.width = `${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%`;
    }
  }

  private applyChrome(): void {
    if (document.getElementById('stage-hud-style')) return;
    const style = document.createElement('style');
    style.id = 'stage-hud-style';
    style.textContent = `
      #stage-hud {
        position: fixed;
        top: 0.8rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 7;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.35rem 0.9rem;
        background: rgba(10, 12, 22, 0.78);
        border: 1px solid #2a2a40;
        border-radius: 999px;
        color: #cfd6e0;
        font-family: 'SF Mono', Consolas, monospace;
        font-size: 0.82rem;
        letter-spacing: 0.06em;
        pointer-events: none;
      }
      #stage-hud .sh-stage { color: #6ee7ff; }
      #stage-hud .sh-sep { color: #5a6275; }
      #stage-hud .sh-phase { color: #cfd6e0; }
      #stage-hud .sh-timer {
        width: 6rem;
        height: 0.45rem;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 999px;
        overflow: hidden;
        margin-left: 0.3rem;
      }
      #stage-hud .sh-timer-fill {
        height: 100%;
        background: linear-gradient(90deg, #6ee7ff, #ffcc6e);
        width: 0%;
        transition: width 80ms linear;
      }
      #stage-hud-runend {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(8, 8, 15, 0.78);
        z-index: 9;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #stage-hud-runend .sh-runend-card {
        padding: 2rem 3rem;
        background: rgba(20, 22, 36, 0.92);
        border: 1px solid #2a2a40;
        border-radius: 12px;
        text-align: center;
      }
      #stage-hud-runend .sh-runend-title {
        color: #ffcc6e;
        font-size: 1.6rem;
        letter-spacing: 0.3em;
      }
      #stage-hud-runend .sh-runend-sub {
        color: #aab2c2;
        font-size: 0.85rem;
        margin-top: 0.6rem;
        font-family: 'SF Mono', Consolas, monospace;
      }
    `;
    document.head.appendChild(style);
  }
}
