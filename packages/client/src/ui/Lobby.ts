import { SERVER_HTTP } from '../config.js';

export interface LobbyResult {
  roomCode: string;
  name: string;
}

export function showLobby(): Promise<LobbyResult> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'lobby';
    document.body.appendChild(root);

    const finish = (roomCode: string, name: string) => {
      root.remove();
      resolve({ roomCode, name });
    };

    renderHome(root, finish);
  });
}

// ----- Home screen: pick name, create or enter a code -----

function renderHome(
  root: HTMLElement,
  finish: (code: string, name: string) => void,
): void {
  root.innerHTML = `
    <h1>GRIDFORCE</h1>
    <div style="opacity:0.7; margin-bottom: 0.5rem; text-align:center;">
      Phase 0 — engine + netcode foundation<br/>
      WASD or arrows to walk. Space or shift to dash. Backtick (\`) adds a bot.
    </div>
    <input id="lob-name" placeholder="Your name" maxlength="16" />
    <button id="lob-create">Create new room</button>
    <div class="row">
      <input id="lob-code" placeholder="Room code" maxlength="6" style="text-transform:uppercase; width: 8rem;" />
      <button id="lob-join">Join room</button>
    </div>
    <div class="err" id="lob-err"></div>
  `;

  const nameInput = root.querySelector<HTMLInputElement>('#lob-name')!;
  const codeInput = root.querySelector<HTMLInputElement>('#lob-code')!;
  const createBtn = root.querySelector<HTMLButtonElement>('#lob-create')!;
  const joinBtn = root.querySelector<HTMLButtonElement>('#lob-join')!;
  const err = root.querySelector<HTMLDivElement>('#lob-err')!;

  if (!nameInput.value) {
    nameInput.value = `Player${Math.floor(Math.random() * 9000) + 1000}`;
  }

  createBtn.addEventListener('click', async () => {
    err.textContent = '';
    createBtn.disabled = true;
    try {
      const resp = await fetch(`${SERVER_HTTP}/api/rooms`, { method: 'POST' });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const data = (await resp.json()) as { code: string };
      const name = nameInput.value.trim() || 'Player';
      renderRoomCreated(root, data.code, name, finish);
    } catch (e) {
      err.textContent = `Failed to create room: ${(e as Error).message}`;
      createBtn.disabled = false;
    }
  });

  joinBtn.addEventListener('click', () => {
    err.textContent = '';
    const code = codeInput.value.trim().toUpperCase();
    if (code.length === 0) {
      err.textContent = 'Enter a room code';
      return;
    }
    finish(code, nameInput.value.trim() || 'Player');
  });

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
  });
}

// ----- After-create screen: show code, let user copy, then Start -----

function renderRoomCreated(
  root: HTMLElement,
  code: string,
  name: string,
  finish: (code: string, name: string) => void,
): void {
  root.innerHTML = `
    <h1>ROOM READY</h1>
    <div style="opacity:0.7; text-align:center;">
      Share this code with your friends so they can join.
    </div>
    <div id="lob-code-display" style="
      font-family: 'SF Mono', Consolas, monospace;
      font-size: 3rem;
      letter-spacing: 0.4em;
      padding: 1rem 1.5rem;
      background: #11122a;
      border: 1px solid #6ee7ff;
      border-radius: 8px;
      color: #6ee7ff;
      user-select: all;
      cursor: text;
    "></div>
    <div class="row">
      <button id="lob-copy">Copy code</button>
      <button id="lob-start">Start →</button>
    </div>
    <button id="lob-back" style="opacity:0.6;">Back</button>
    <div class="err" id="lob-status" style="color:#9dffa0; min-height:1.2em;"></div>
  `;

  const codeEl = root.querySelector<HTMLDivElement>('#lob-code-display')!;
  codeEl.textContent = code;
  const copyBtn = root.querySelector<HTMLButtonElement>('#lob-copy')!;
  const startBtn = root.querySelector<HTMLButtonElement>('#lob-start')!;
  const backBtn = root.querySelector<HTMLButtonElement>('#lob-back')!;
  const status = root.querySelector<HTMLDivElement>('#lob-status')!;

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      status.textContent = 'Copied!';
      setTimeout(() => {
        status.textContent = '';
      }, 1500);
    } catch {
      status.textContent = 'Could not copy — select the code manually.';
    }
  });

  startBtn.addEventListener('click', () => {
    finish(code, name);
  });

  backBtn.addEventListener('click', () => {
    renderHome(root, finish);
  });

  // Pressing Enter in this view starts the game
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Enter') {
      window.removeEventListener('keydown', onKey);
      finish(code, name);
    }
  };
  window.addEventListener('keydown', onKey);
}
