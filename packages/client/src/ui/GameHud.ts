// In-game HUD overlay. B1 shows the local player's carbon count + a small
// progress bar while they're holding repair on a damaged tile. Future
// tasks (B2) will extend with HP, city HP, wave counter.

import { REPAIR_DURATION_S } from '@gridforce/shared';

export interface GameHudState {
  carbon: number;
  repairProgressS: number; // 0 .. REPAIR_DURATION_S
}

export class GameHud {
  private root: HTMLDivElement;
  private carbonEl: HTMLSpanElement;
  private repairBar: HTMLDivElement;
  private repairFill: HTMLDivElement;
  private lastSig = '';

  constructor() {
    this.applyChrome();
    this.root = document.createElement('div');
    this.root.id = 'game-hud';

    this.carbonEl = document.createElement('span');
    this.carbonEl.className = 'gh-carbon';
    this.root.appendChild(this.carbonEl);

    this.repairBar = document.createElement('div');
    this.repairBar.className = 'gh-repair';
    this.repairBar.style.display = 'none';
    this.repairFill = document.createElement('div');
    this.repairFill.className = 'gh-repair-fill';
    this.repairBar.appendChild(this.repairFill);
    this.root.appendChild(this.repairBar);

    document.body.appendChild(this.root);
  }

  destroy(): void {
    this.root.remove();
  }

  update(s: GameHudState): void {
    const repairBucket = Math.round((s.repairProgressS / REPAIR_DURATION_S) * 100);
    const sig = `${s.carbon}|${repairBucket}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.carbonEl.textContent = `⚡ ${s.carbon}`;
    if (s.repairProgressS > 0) {
      this.repairBar.style.display = '';
      this.repairFill.style.width = `${Math.max(0, Math.min(100, repairBucket))}%`;
    } else {
      this.repairBar.style.display = 'none';
    }
  }

  private applyChrome(): void {
    if (document.getElementById('game-hud-style')) return;
    const style = document.createElement('style');
    style.id = 'game-hud-style';
    style.textContent = `
      #game-hud {
        position: fixed; top: 1rem; left: 1rem; z-index: 7;
        font-family: 'SF Mono', Consolas, monospace; color: #ffd633;
        font-size: 1.1rem; pointer-events: none;
        background: rgba(10, 12, 22, 0.7); padding: 0.4rem 0.8rem;
        border: 1px solid #2a2a40; border-radius: 8px;
      }
      #game-hud .gh-carbon { display: inline-block; min-width: 4rem; }
      #game-hud .gh-repair {
        width: 8rem; height: 0.4rem; background: rgba(255,255,255,0.08);
        border-radius: 4px; overflow: hidden; margin-top: 0.4rem;
      }
      #game-hud .gh-repair-fill {
        height: 100%; background: #6ee7ff; width: 0%;
        transition: width 60ms linear;
      }
    `;
    document.head.appendChild(style);
  }
}
