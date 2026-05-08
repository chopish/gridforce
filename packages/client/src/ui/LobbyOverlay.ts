// Pre-game lobby screen. While the room is in 'lobby' phase the body gets
// `data-phase="lobby"`, the playfield canvas + debug HUD are hidden via
// CSS, and this screen takes over the viewport.
//
// Two-column layout:
//   left  — title, room meta, player roster (host crown + ready chips)
//   right — settings (level / difficulty / max players), invite generator
//   bottom — Ready / Start Game (host only)
//
// The screen is data-driven: main.ts calls update() each frame with the
// latest mirror of phase/hostId/levelId/difficulty/players. Any change
// rebuilds the affected DOM (the renderer is small enough that we don't
// bother with VDOM tricks — a signature compare gates rebuilds).

import {
  DIFFICULTY_NAMES,
  Difficulty,
  LEVELS,
  type DifficultyValue,
  type PlayerId,
  type PlayerState,
} from '@gridforce/shared';

export interface LobbyOverlayCallbacks {
  onToggleReady(next: boolean): void;
  onStartGame(): void;
  onChangeLevel(levelId: string): void;
  onChangeDifficulty(value: DifficultyValue): void;
  // Returns the shareable URL for a fresh invite. Throws on error.
  onGenerateInvite(maxUses: number): Promise<string>;
}

export interface LobbyOverlayState {
  phase: 'lobby' | 'playing';
  hostId: PlayerId;
  localPlayerId: PlayerId;
  roomCode: string;
  levelId: string;
  difficulty: number;
  maxPlayers: number;
  players: PlayerState[];
}

const DIFFICULTIES: Array<{ value: DifficultyValue; label: string }> = [
  { value: Difficulty.Easy, label: DIFFICULTY_NAMES[Difficulty.Easy] },
  { value: Difficulty.Normal, label: DIFFICULTY_NAMES[Difficulty.Normal] },
  { value: Difficulty.Hard, label: DIFFICULTY_NAMES[Difficulty.Hard] },
];

export class LobbyOverlay {
  private root: HTMLDivElement;
  private title: HTMLDivElement;
  private subtitle: HTMLDivElement;
  private rosterList: HTMLDivElement;
  private rosterCount: HTMLSpanElement;
  private levelSelect!: HTMLSelectElement;
  private levelDescription: HTMLDivElement;
  private difficultySelect!: HTMLSelectElement;
  private settingsLockedNote: HTMLDivElement;
  private maxPlayersValue: HTMLSpanElement;
  private inviteUsesSelect: HTMLSelectElement;
  private inviteGenerateBtn: HTMLButtonElement;
  private inviteResult: HTMLDivElement;
  private inviteUrlInput: HTMLInputElement;
  private inviteCopyBtn: HTMLButtonElement;
  private inviteError: HTMLDivElement;
  private readyBtn: HTMLButtonElement;
  private startBtn: HTMLButtonElement;
  private hint: HTMLDivElement;

  private lastSig = '';

  constructor(private readonly cb: LobbyOverlayCallbacks) {
    this.applyChrome();

    this.root = document.createElement('div');
    this.root.id = 'pregame-lobby';
    this.root.style.display = 'none';

    // Header
    const header = document.createElement('div');
    header.className = 'pl-header';
    this.title = document.createElement('div');
    this.title.className = 'pl-title';
    this.title.textContent = 'GRIDFORCE';
    header.appendChild(this.title);
    this.subtitle = document.createElement('div');
    this.subtitle.className = 'pl-subtitle';
    header.appendChild(this.subtitle);
    this.root.appendChild(header);

    // Two-column body
    const body = document.createElement('div');
    body.className = 'pl-body';

    // Left: roster
    const left = document.createElement('div');
    left.className = 'pl-col pl-col-left';
    const rosterTitle = document.createElement('div');
    rosterTitle.className = 'pl-section-title';
    rosterTitle.innerHTML = 'Players <span class="pl-roster-count" id="pl-roster-count"></span>';
    this.rosterCount = rosterTitle.querySelector('#pl-roster-count') as HTMLSpanElement;
    left.appendChild(rosterTitle);
    this.rosterList = document.createElement('div');
    this.rosterList.className = 'pl-list';
    left.appendChild(this.rosterList);

    // Right: settings
    const right = document.createElement('div');
    right.className = 'pl-col pl-col-right';
    const settingsTitle = document.createElement('div');
    settingsTitle.className = 'pl-section-title';
    settingsTitle.textContent = 'Settings';
    right.appendChild(settingsTitle);

    right.appendChild(this.makeFieldRow('Level', this.levelSelectBuild()));
    this.levelDescription = document.createElement('div');
    this.levelDescription.className = 'pl-field-help';
    right.appendChild(this.levelDescription);

    right.appendChild(this.makeFieldRow('Difficulty', this.difficultySelectBuild()));

    const maxRow = document.createElement('div');
    maxRow.className = 'pl-field';
    const maxLabel = document.createElement('span');
    maxLabel.className = 'pl-field-label';
    maxLabel.textContent = 'Max players';
    maxRow.appendChild(maxLabel);
    this.maxPlayersValue = document.createElement('span');
    this.maxPlayersValue.className = 'pl-field-readonly';
    maxRow.appendChild(this.maxPlayersValue);
    right.appendChild(maxRow);

    this.settingsLockedNote = document.createElement('div');
    this.settingsLockedNote.className = 'pl-field-help pl-locked-note';
    this.settingsLockedNote.textContent = 'Only the host can change these.';
    right.appendChild(this.settingsLockedNote);

    // Invite block (host only)
    const inviteSection = document.createElement('div');
    inviteSection.className = 'pl-invite-section';
    const inviteTitle = document.createElement('div');
    inviteTitle.className = 'pl-section-title';
    inviteTitle.textContent = 'Invite a friend';
    inviteSection.appendChild(inviteTitle);
    const inviteRow = document.createElement('div');
    inviteRow.className = 'pl-field';
    const inviteUsesLabel = document.createElement('span');
    inviteUsesLabel.className = 'pl-field-label';
    inviteUsesLabel.textContent = 'Uses';
    inviteRow.appendChild(inviteUsesLabel);
    this.inviteUsesSelect = document.createElement('select');
    this.inviteUsesSelect.className = 'pl-select';
    inviteRow.appendChild(this.inviteUsesSelect);
    inviteSection.appendChild(inviteRow);

    this.inviteGenerateBtn = document.createElement('button');
    this.inviteGenerateBtn.className = 'pl-btn pl-btn-secondary';
    this.inviteGenerateBtn.textContent = 'Generate invite link';
    inviteSection.appendChild(this.inviteGenerateBtn);

    this.inviteResult = document.createElement('div');
    this.inviteResult.className = 'pl-invite-result';
    this.inviteResult.style.display = 'none';
    this.inviteUrlInput = document.createElement('input');
    this.inviteUrlInput.readOnly = true;
    this.inviteUrlInput.className = 'pl-invite-url';
    this.inviteUrlInput.onclick = () => this.inviteUrlInput.select();
    this.inviteResult.appendChild(this.inviteUrlInput);
    this.inviteCopyBtn = document.createElement('button');
    this.inviteCopyBtn.className = 'pl-btn pl-btn-small';
    this.inviteCopyBtn.textContent = 'Copy';
    this.inviteResult.appendChild(this.inviteCopyBtn);
    inviteSection.appendChild(this.inviteResult);

    this.inviteError = document.createElement('div');
    this.inviteError.className = 'pl-err';
    inviteSection.appendChild(this.inviteError);

    right.appendChild(inviteSection);

    body.appendChild(left);
    body.appendChild(right);
    this.root.appendChild(body);

    // Footer: hint + actions
    this.hint = document.createElement('div');
    this.hint.className = 'pl-hint';
    this.root.appendChild(this.hint);

    const actions = document.createElement('div');
    actions.className = 'pl-actions';
    this.readyBtn = document.createElement('button');
    this.readyBtn.className = 'pl-btn pl-ready';
    this.readyBtn.textContent = 'Ready';
    actions.appendChild(this.readyBtn);
    this.startBtn = document.createElement('button');
    this.startBtn.className = 'pl-btn pl-start';
    this.startBtn.textContent = 'Start Game';
    actions.appendChild(this.startBtn);
    this.root.appendChild(actions);

    document.body.appendChild(this.root);

    this.wireEvents();
  }

  destroy(): void {
    this.root.remove();
    document.body.removeAttribute('data-phase');
  }

  update(s: LobbyOverlayState): void {
    if (s.phase === 'playing') {
      this.root.style.display = 'none';
      document.body.removeAttribute('data-phase');
      return;
    }
    this.root.style.display = '';
    document.body.dataset.phase = 'lobby';

    const isHost = s.hostId === s.localPlayerId;
    const localState = s.players.find((p) => p.id === s.localPlayerId);
    const localReady = !!localState?.ready;
    const otherCount = Math.max(0, s.maxPlayers - s.players.length);

    const sig = [
      s.phase,
      s.hostId,
      s.localPlayerId,
      s.roomCode,
      s.levelId,
      s.difficulty,
      s.maxPlayers,
      localReady,
      isHost,
      otherCount,
      s.players.map((p) => `${p.id}:${p.ready ? 'r' : '-'}:${p.name}`).join(','),
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.subtitle.textContent = s.roomCode ? `Room ${s.roomCode}` : 'Pre-game';

    this.rosterCount.textContent = `(${s.players.length}/${s.maxPlayers})`;
    this.rosterList.innerHTML = '';
    for (const p of s.players) {
      const row = document.createElement('div');
      row.className = 'pl-row';
      if (p.id === s.localPlayerId) row.classList.add('pl-self');
      const name = document.createElement('span');
      name.className = 'pl-name';
      const crown = p.id === s.hostId ? '♔ ' : '';
      name.textContent = `${crown}${p.name || `player ${p.id}`}`;
      row.appendChild(name);
      const chip = document.createElement('span');
      chip.className = `pl-chip ${p.ready ? 'on' : 'off'}`;
      chip.textContent = p.ready ? 'ready' : 'not ready';
      row.appendChild(chip);
      this.rosterList.appendChild(row);
    }

    // Selectors. Mirror server-canonical values; host can edit, guests can't.
    this.levelSelect.value = s.levelId;
    if (this.levelSelect.value !== s.levelId) {
      // Server picked a level we don't know about (forward compat). Show the
      // raw id so the host at least sees what's selected.
      const opt = document.createElement('option');
      opt.value = s.levelId;
      opt.textContent = s.levelId;
      this.levelSelect.appendChild(opt);
      this.levelSelect.value = s.levelId;
    }
    const knownLevel = LEVELS.find((l) => l.id === s.levelId);
    this.levelDescription.textContent = knownLevel ? knownLevel.description : '';
    this.difficultySelect.value = String(s.difficulty);
    this.maxPlayersValue.textContent = String(s.maxPlayers);

    this.levelSelect.disabled = !isHost;
    this.difficultySelect.disabled = !isHost;
    this.settingsLockedNote.style.display = isHost ? 'none' : '';

    // Invite uses dropdown options: 1..min(maxPlayers - 1, openSeats). Cap
    // at openSeats since over-issuing is meaningless when the room is full.
    // Also cap at (maxPlayers - 1) so hosts can't generate "infinite seats"
    // even temporarily.
    const inviteCap = Math.max(1, Math.min(s.maxPlayers - 1, otherCount));
    if (this.inviteUsesSelect.options.length !== inviteCap) {
      this.inviteUsesSelect.innerHTML = '';
      for (let n = 1; n <= inviteCap; n++) {
        const opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = String(n);
        this.inviteUsesSelect.appendChild(opt);
      }
    }
    const inviteAvail = isHost && otherCount > 0;
    this.inviteUsesSelect.disabled = !inviteAvail;
    this.inviteGenerateBtn.disabled = !inviteAvail;
    document
      .querySelectorAll('.pl-invite-section')
      .forEach((el) => ((el as HTMLDivElement).style.display = isHost ? '' : 'none'));

    // Ready / Start buttons
    this.readyBtn.classList.toggle('on', localReady);
    this.readyBtn.textContent = localReady ? 'Ready ✓' : 'Ready';
    this.readyBtn.dataset.local = localReady ? '1' : '0';

    this.startBtn.style.display = isHost ? '' : 'none';
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

  private wireEvents(): void {
    this.readyBtn.addEventListener('click', () => {
      const desired = this.readyBtn.dataset.local !== '1';
      this.cb.onToggleReady(desired);
      this.readyBtn.dataset.local = desired ? '1' : '0';
      this.readyBtn.classList.toggle('on', desired);
    });
    this.startBtn.addEventListener('click', () => this.cb.onStartGame());
    this.levelSelect.addEventListener('change', () => {
      this.cb.onChangeLevel(this.levelSelect.value);
    });
    this.difficultySelect.addEventListener('change', () => {
      const v = Number(this.difficultySelect.value) as DifficultyValue;
      this.cb.onChangeDifficulty(v);
    });
    this.inviteGenerateBtn.addEventListener('click', () => {
      const uses = Math.max(1, Number(this.inviteUsesSelect.value) || 1);
      this.inviteError.textContent = '';
      this.inviteResult.style.display = '';
      this.inviteUrlInput.value = 'generating…';
      this.inviteCopyBtn.disabled = true;
      this.cb
        .onGenerateInvite(uses)
        .then((url) => {
          this.inviteUrlInput.value = url;
          this.inviteCopyBtn.disabled = false;
          this.inviteUrlInput.focus();
          this.inviteUrlInput.select();
        })
        .catch((e: unknown) => {
          this.inviteUrlInput.value = '';
          this.inviteError.textContent = e instanceof Error ? e.message : String(e);
        });
    });
    this.inviteCopyBtn.addEventListener('click', () => {
      const url = this.inviteUrlInput.value;
      if (!url) return;
      void navigator.clipboard?.writeText(url);
      this.inviteCopyBtn.textContent = 'Copied!';
      setTimeout(() => (this.inviteCopyBtn.textContent = 'Copy'), 1200);
    });
  }

  private makeFieldRow(label: string, control: HTMLElement): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'pl-field';
    const lab = document.createElement('span');
    lab.className = 'pl-field-label';
    lab.textContent = label;
    row.appendChild(lab);
    row.appendChild(control);
    return row;
  }

  private levelSelectBuild(): HTMLSelectElement {
    this.levelSelect = document.createElement('select');
    this.levelSelect.className = 'pl-select';
    for (const l of LEVELS) {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      this.levelSelect.appendChild(opt);
    }
    return this.levelSelect;
  }

  private difficultySelectBuild(): HTMLSelectElement {
    this.difficultySelect = document.createElement('select');
    this.difficultySelect.className = 'pl-select';
    for (const d of DIFFICULTIES) {
      const opt = document.createElement('option');
      opt.value = String(d.value);
      opt.textContent = d.label;
      this.difficultySelect.appendChild(opt);
    }
    return this.difficultySelect;
  }

  private applyChrome(): void {
    if (document.getElementById('pregame-lobby-style')) return;
    const style = document.createElement('style');
    style.id = 'pregame-lobby-style';
    style.textContent = `
      body[data-phase="lobby"] #app,
      body[data-phase="lobby"] #hud,
      body[data-phase="lobby"] #netsim {
        display: none !important;
      }
      #pregame-lobby {
        position: fixed;
        inset: 0;
        background: radial-gradient(circle at 50% 30%, #14182a 0%, #08080f 70%);
        color: #cfd6e0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        z-index: 8;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 2.5rem 1rem 2rem;
        box-sizing: border-box;
        overflow-y: auto;
      }
      #pregame-lobby .pl-header {
        text-align: center;
        margin-bottom: 1.5rem;
      }
      #pregame-lobby .pl-title {
        font-size: 2.2rem;
        letter-spacing: 0.3em;
        color: #6ee7ff;
      }
      #pregame-lobby .pl-subtitle {
        font-size: 0.9rem;
        letter-spacing: 0.18em;
        color: #aab2c2;
        margin-top: 0.2rem;
        font-family: 'SF Mono', Consolas, monospace;
      }
      #pregame-lobby .pl-body {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1.6rem;
        width: min(100%, 50rem);
      }
      #pregame-lobby .pl-col {
        background: rgba(20, 22, 36, 0.8);
        border: 1px solid #2a2a40;
        border-radius: 10px;
        padding: 1rem 1.1rem;
      }
      #pregame-lobby .pl-section-title {
        font-size: 0.85rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #aab2c2;
        margin-bottom: 0.6rem;
      }
      #pregame-lobby .pl-roster-count {
        color: #6ee7ff;
        font-family: 'SF Mono', Consolas, monospace;
      }
      #pregame-lobby .pl-list {
        display: flex; flex-direction: column; gap: 0.4rem;
      }
      #pregame-lobby .pl-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0.5rem 0.7rem;
        border: 1px solid #2a2a40;
        border-radius: 4px;
        background: rgba(10, 12, 22, 0.6);
      }
      #pregame-lobby .pl-row.pl-self { border-color: #6ee7ff55; }
      #pregame-lobby .pl-name { font-family: 'SF Mono', Consolas, monospace; }
      #pregame-lobby .pl-chip {
        font-size: 0.7rem;
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
        letter-spacing: 0.08em;
      }
      #pregame-lobby .pl-chip.on  {
        background: #1e4a3a; color: #6effa6; border: 1px solid #2c7755;
      }
      #pregame-lobby .pl-chip.off {
        background: #232842; color: #aab2c2; border: 1px solid #303048;
      }
      #pregame-lobby .pl-field {
        display: flex; align-items: center; justify-content: space-between;
        gap: 0.6rem;
        margin-bottom: 0.5rem;
      }
      #pregame-lobby .pl-field-label {
        font-size: 0.85rem;
        color: #cfd6e0;
        flex: 0 0 auto;
      }
      #pregame-lobby .pl-field-readonly {
        font-family: 'SF Mono', Consolas, monospace;
        color: #6ee7ff;
      }
      #pregame-lobby .pl-field-help {
        font-size: 0.78rem;
        color: #8a93a6;
        margin-bottom: 0.5rem;
      }
      #pregame-lobby .pl-locked-note { color: #ffcc6e; }
      #pregame-lobby .pl-select {
        padding: 0.4rem 0.6rem;
        background: #0d0d18;
        color: #cfd6e0;
        border: 1px solid #303048;
        border-radius: 4px;
        font-family: inherit;
        font-size: 0.9rem;
        flex: 1 1 auto;
        max-width: 14rem;
      }
      #pregame-lobby .pl-select:disabled { opacity: 0.55; cursor: not-allowed; }
      #pregame-lobby .pl-invite-section { margin-top: 1rem; }
      #pregame-lobby .pl-invite-result {
        display: flex;
        gap: 0.4rem;
        margin-top: 0.6rem;
      }
      #pregame-lobby .pl-invite-url {
        flex: 1 1 auto;
        font-family: 'SF Mono', Consolas, monospace;
        font-size: 0.78rem;
        background: #0d0d18;
        color: #cfd6e0;
        border: 1px solid #303048;
        border-radius: 4px;
        padding: 0.4rem 0.5rem;
      }
      #pregame-lobby .pl-btn {
        padding: 0.55rem 1rem;
        font-size: 0.95rem;
        background: #1a1a2e;
        color: #cfd6e0;
        border: 1px solid #303048;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
      }
      #pregame-lobby .pl-btn:hover:not(:disabled) {
        background: #232342; border-color: #6ee7ff;
      }
      #pregame-lobby .pl-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      #pregame-lobby .pl-btn-small { padding: 0.4rem 0.7rem; font-size: 0.85rem; }
      #pregame-lobby .pl-btn-secondary { width: 100%; margin-top: 0.4rem; }
      #pregame-lobby .pl-err {
        font-size: 0.8rem;
        color: #ff6e6e;
        min-height: 0;
        margin-top: 0.4rem;
      }
      #pregame-lobby .pl-hint {
        font-size: 0.9rem;
        color: #aab2c2;
        margin: 1.2rem 0 0.6rem;
        text-align: center;
      }
      #pregame-lobby .pl-actions {
        display: flex; gap: 1rem; justify-content: center;
        width: min(100%, 50rem);
      }
      #pregame-lobby .pl-actions .pl-btn {
        flex: 1; max-width: 14rem;
      }
      #pregame-lobby .pl-ready.on {
        background: #1e4a3a; color: #6effa6; border-color: #2c7755;
      }
      #pregame-lobby .pl-start { color: #ffcc6e; border-color: #6e5326; }
      #pregame-lobby .pl-start:hover:not(:disabled) {
        background: #3a2a1e; border-color: #ffcc6e;
      }
      @media (max-width: 700px) {
        #pregame-lobby .pl-body { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }
}
