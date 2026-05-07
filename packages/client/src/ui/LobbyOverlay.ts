// Pre-game lobby panel. Shows the room roster, ready chips, host crown,
// and the Ready / Start Game controls. Driven each frame from the
// PredictedWorld snapshot mirror — the panel is visible while phase ===
// 'lobby' and hides itself the moment phase flips to 'playing'.
//
// The overlay does not own any state; it just renders the latest
// roster + phase/host data and forwards button clicks via callbacks.

import type { PlayerId, PlayerState } from '@gridforce/shared';

export interface LobbyOverlayCallbacks {
  onToggleReady(next: boolean): void;
  onStartGame(): void;
}

export interface LobbyOverlayState {
  phase: 'lobby' | 'playing';
  hostId: PlayerId;
  localPlayerId: PlayerId;
  roomCode: string;
  players: PlayerState[];
}

export class LobbyOverlay {
  private root: HTMLDivElement;
  private title: HTMLDivElement;
  private list: HTMLDivElement;
  private readyBtn: HTMLButtonElement;
  private startBtn: HTMLButtonElement;
  private hint: HTMLDivElement;

  // Cache last-rendered values so we don't thrash the DOM every frame.
  private lastSig = '';

  constructor(private readonly cb: LobbyOverlayCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'pregame-lobby';
    this.applyChrome();

    this.title = document.createElement('div');
    this.title.className = 'pl-title';
    this.root.appendChild(this.title);

    this.list = document.createElement('div');
    this.list.className = 'pl-list';
    this.root.appendChild(this.list);

    this.hint = document.createElement('div');
    this.hint.className = 'pl-hint';
    this.root.appendChild(this.hint);

    this.readyBtn = document.createElement('button');
    this.readyBtn.className = 'pl-ready';
    this.readyBtn.textContent = 'Ready';
    this.root.appendChild(this.readyBtn);

    this.startBtn = document.createElement('button');
    this.startBtn.className = 'pl-start';
    this.startBtn.textContent = 'Start Game';
    this.root.appendChild(this.startBtn);

    document.body.appendChild(this.root);
    this.root.style.display = 'none';

    this.readyBtn.addEventListener('click', () => {
      const desired = !this.localReadyFromDom();
      this.cb.onToggleReady(desired);
      // Optimistically reflect — server will confirm on next snapshot.
      this.readyBtn.dataset.local = desired ? '1' : '0';
      this.readyBtn.classList.toggle('on', desired);
    });
    this.startBtn.addEventListener('click', () => {
      this.cb.onStartGame();
    });
  }

  destroy(): void {
    this.root.remove();
  }

  // Called every frame from main.ts with the latest snapshot mirror.
  update(s: LobbyOverlayState): void {
    if (s.phase === 'playing') {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';

    const isHost = s.hostId === s.localPlayerId;
    const localState = s.players.find((p) => p.id === s.localPlayerId);
    const localReady = !!localState?.ready;

    // Build a signature so the DOM only changes when something changed.
    const sig =
      `${s.phase}|${s.hostId}|${s.localPlayerId}|${s.roomCode}|${localReady}|${isHost}|` +
      s.players.map((p) => `${p.id}:${p.ready ? 'r' : '-'}:${p.name}`).join(',');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.title.textContent = s.roomCode ? `Room ${s.roomCode}` : 'Pre-game Lobby';

    this.list.innerHTML = '';
    for (const p of s.players) {
      const row = document.createElement('div');
      row.className = 'pl-row';
      if (p.id === s.localPlayerId) row.classList.add('pl-self');

      const left = document.createElement('span');
      left.className = 'pl-name';
      const crown = p.id === s.hostId ? '♔ ' : '';
      const display = p.name || `player ${p.id}`;
      left.textContent = `${crown}${display}`;
      row.appendChild(left);

      const chip = document.createElement('span');
      chip.className = `pl-chip ${p.ready ? 'on' : 'off'}`;
      chip.textContent = p.ready ? 'ready' : '…';
      row.appendChild(chip);

      this.list.appendChild(row);
    }

    this.readyBtn.classList.toggle('on', localReady);
    this.readyBtn.textContent = localReady ? 'Ready ✓' : 'Ready';
    this.readyBtn.dataset.local = localReady ? '1' : '0';

    this.startBtn.style.display = isHost ? '' : 'none';
    // Start is enabled when the host is ready themselves AND any non-host
    // human is also ready. With only the host present, we still allow start
    // (solo-co-op lobby of 1) — they're effectively ready-with-themselves.
    const others = s.players.filter((p) => p.id !== s.hostId);
    const someoneElseReady = others.length === 0 || others.some((p) => p.ready);
    const canStart = isHost && localReady && someoneElseReady;
    this.startBtn.disabled = !canStart;

    if (!isHost) {
      this.hint.textContent = 'waiting for host to start the game';
    } else if (!localReady) {
      this.hint.textContent = 'mark yourself ready, then start';
    } else if (!someoneElseReady && others.length > 0) {
      this.hint.textContent = 'waiting for at least one other player to ready up';
    } else {
      this.hint.textContent = 'all set — press Start Game when ready';
    }
  }

  private localReadyFromDom(): boolean {
    return this.readyBtn.dataset.local === '1';
  }

  // Inject minimal CSS scoped to this overlay. Avoids a separate stylesheet
  // and keeps the panel self-contained.
  private applyChrome(): void {
    if (document.getElementById('pregame-lobby-style')) return;
    const style = document.createElement('style');
    style.id = 'pregame-lobby-style';
    style.textContent = `
      #pregame-lobby {
        position: fixed; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(10, 10, 15, 0.92);
        border: 1px solid #303048;
        border-radius: 8px;
        padding: 18px 22px;
        min-width: 22rem;
        z-index: 8;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #cfd6e0;
        display: flex; flex-direction: column; gap: 0.65rem;
      }
      #pregame-lobby .pl-title {
        font-size: 1.1rem;
        letter-spacing: 0.18em;
        color: #6ee7ff;
        text-align: center;
        margin-bottom: 0.4rem;
      }
      #pregame-lobby .pl-list {
        display: flex; flex-direction: column; gap: 0.35rem;
        max-height: 14rem; overflow-y: auto;
      }
      #pregame-lobby .pl-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0.4rem 0.7rem;
        border: 1px solid #2a2a40;
        border-radius: 4px;
        background: rgba(20, 20, 30, 0.6);
      }
      #pregame-lobby .pl-row.pl-self { border-color: #6ee7ff44; }
      #pregame-lobby .pl-name { font-family: 'SF Mono', Consolas, monospace; }
      #pregame-lobby .pl-chip {
        font-size: 0.75rem;
        padding: 0.15rem 0.55rem;
        border-radius: 999px;
        letter-spacing: 0.08em;
      }
      #pregame-lobby .pl-chip.on  { background: #1e4a3a; color: #6effa6; border: 1px solid #2c7755; }
      #pregame-lobby .pl-chip.off { background: #3a2a1e; color: #ffcc6e; border: 1px solid #6e5326; }
      #pregame-lobby .pl-hint { font-size: 0.85rem; opacity: 0.75; text-align: center; }
      #pregame-lobby button {
        padding: 0.55rem 1rem;
        font-size: 0.95rem;
        background: #1a1a2e;
        color: #cfd6e0;
        border: 1px solid #303048;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
      }
      #pregame-lobby button:hover:not(:disabled) {
        background: #232342; border-color: #6ee7ff;
      }
      #pregame-lobby button:disabled { opacity: 0.4; cursor: not-allowed; }
      #pregame-lobby .pl-ready.on {
        background: #1e4a3a; color: #6effa6; border-color: #2c7755;
      }
      #pregame-lobby .pl-start { color: #ffcc6e; border-color: #6e5326; }
      #pregame-lobby .pl-start:hover:not(:disabled) {
        background: #3a2a1e; border-color: #ffcc6e;
      }
    `;
    document.head.appendChild(style);
  }
}
