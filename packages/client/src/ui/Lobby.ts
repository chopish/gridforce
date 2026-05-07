// Lightweight DOM-based lobby. Two screens:
//   1) "Create new room" or "Join existing" picker
//   2) Room code display (after creating) with copy-to-clipboard
//
// Submitting either path produces a roomCode + name and resolves the promise
// returned by `show()`.

export interface LobbyResult {
  roomCode: string;
  name: string;
}

export class Lobby {
  private root: HTMLDivElement;
  private resolveFn: ((r: LobbyResult) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    parent.appendChild(this.root);
  }

  show(): Promise<LobbyResult> {
    this.renderPicker();
    return new Promise<LobbyResult>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  hide(): void {
    this.root.remove();
  }

  private renderPicker(): void {
    this.root.innerHTML = '';
    const h = document.createElement('h1');
    h.textContent = 'GRIDFORCE';
    this.root.appendChild(h);

    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'name (optional)';
    nameInput.maxLength = 24;
    nameRow.appendChild(nameInput);
    this.root.appendChild(nameRow);

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Create new room';
    this.root.appendChild(createBtn);

    const joinRow = document.createElement('div');
    joinRow.className = 'row';
    const codeInput = document.createElement('input');
    codeInput.placeholder = 'room code';
    codeInput.maxLength = 8;
    codeInput.style.textTransform = 'uppercase';
    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Join';
    joinBtn.style.minWidth = '6rem';
    joinRow.appendChild(codeInput);
    joinRow.appendChild(joinBtn);
    this.root.appendChild(joinRow);

    const err = document.createElement('div');
    err.className = 'err';
    this.root.appendChild(err);

    createBtn.onclick = () => {
      this.finish({ roomCode: '', name: nameInput.value.trim() });
    };
    joinBtn.onclick = () => {
      const code = codeInput.value.trim().toUpperCase();
      if (code.length < 2) {
        err.textContent = 'Enter a room code';
        return;
      }
      this.finish({ roomCode: code, name: nameInput.value.trim() });
    };
    codeInput.onkeydown = (e) => {
      if (e.key === 'Enter') joinBtn.click();
    };
  }

  // Show the joined room code while the connection is alive.
  showRoomCode(code: string): HTMLDivElement {
    const banner = document.createElement('div');
    banner.style.position = 'fixed';
    banner.style.bottom = '8px';
    banner.style.left = '8px';
    banner.style.fontFamily = "'SF Mono', Consolas, monospace";
    banner.style.fontSize = '12px';
    banner.style.color = '#cfd6e0';
    banner.style.background = 'rgba(0,0,0,0.4)';
    banner.style.padding = '6px 10px';
    banner.style.borderRadius = '4px';
    banner.style.zIndex = '5';
    banner.innerHTML = `<span style="opacity:0.7">room</span> <strong style="color:#6ee7ff;letter-spacing:0.1em">${code}</strong> <span style="opacity:0.5">(click to copy)</span>`;
    banner.style.cursor = 'pointer';
    banner.onclick = () => {
      void navigator.clipboard?.writeText(code);
      banner.querySelector('span:last-child')!.textContent = '(copied!)';
      setTimeout(() => {
        const span = banner.querySelector('span:last-child');
        if (span) span.textContent = '(click to copy)';
      }, 1200);
    };
    document.body.appendChild(banner);
    return banner;
  }

  showError(message: string): void {
    const err = this.root.querySelector('.err');
    if (err) err.textContent = message;
  }

  reset(): void {
    this.renderPicker();
    document.body.appendChild(this.root);
  }

  private finish(r: LobbyResult): void {
    if (!this.resolveFn) return;
    const fn = this.resolveFn;
    this.resolveFn = null;
    this.hide();
    fn(r);
  }
}
