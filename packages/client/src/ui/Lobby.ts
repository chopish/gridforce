import { SERVER_HTTP } from '../config.js';

export interface LobbyResult {
  roomCode: string;
  name: string;
}

export function showLobby(): Promise<LobbyResult> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'lobby';
    root.innerHTML = `
      <h1>GRIDFORCE</h1>
      <div style="opacity:0.7; margin-bottom: 0.5rem; text-align:center;">
        Phase 0 — engine + netcode foundation<br/>
        WASD or arrows to walk. Space or shift to dash.
      </div>
      <input id="lob-name" placeholder="Your name" maxlength="16" />
      <button id="lob-create">Create new room</button>
      <div class="row">
        <input id="lob-code" placeholder="Room code" maxlength="6" style="text-transform:uppercase; width: 8rem;" />
        <button id="lob-join">Join room</button>
      </div>
      <div class="err" id="lob-err"></div>
    `;
    document.body.appendChild(root);

    const nameInput = root.querySelector<HTMLInputElement>('#lob-name')!;
    const codeInput = root.querySelector<HTMLInputElement>('#lob-code')!;
    const createBtn = root.querySelector<HTMLButtonElement>('#lob-create')!;
    const joinBtn = root.querySelector<HTMLButtonElement>('#lob-join')!;
    const err = root.querySelector<HTMLDivElement>('#lob-err')!;

    nameInput.value = `Player${Math.floor(Math.random() * 9000) + 1000}`;

    const finish = (roomCode: string, name: string) => {
      root.remove();
      resolve({ roomCode, name });
    };

    createBtn.addEventListener('click', async () => {
      err.textContent = '';
      createBtn.disabled = true;
      try {
        const resp = await fetch(`${SERVER_HTTP}/api/rooms`, { method: 'POST' });
        if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
        const data = (await resp.json()) as { code: string };
        finish(data.code, nameInput.value.trim() || 'Player');
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
  });
}
