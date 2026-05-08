// DOM-based lobby with three views: Browse public rooms, Join by code,
// Create a new room. The lobby's job is to produce a `LobbyResult` that
// includes a roomCode + name + accessKey, which main.ts then hands to
// Socket.connect. Access keys are issued by the server's HTTP layer.
//
// Special case: if the page was opened with `?inv=<token>` we skip the
// tab UI entirely and go straight to a name prompt — main.ts redeems the
// invite before showing the lobby and passes the result in.

import {
  createRoom,
  listPublicRooms,
  requestAccess,
  LobbyApiError,
  type AccessResult,
  type PublicRoomSummary,
} from '../api.js';

export interface LobbyResult {
  roomCode: string;
  name: string;
  accessKey: string;
}

type View = 'home' | 'browse' | 'join' | 'create' | 'invite';

export class Lobby {
  private root: HTMLDivElement;
  private resolveFn: ((r: LobbyResult) => void) | null = null;
  private name = '';
  // Carry-through invite redemption result (set by main.ts when ?inv= present).
  private prefilledInvite: { code: string; accessKey: string; roomName?: string } | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    parent.appendChild(this.root);
  }

  show(): Promise<LobbyResult> {
    if (this.prefilledInvite) {
      this.renderInviteJoin(this.prefilledInvite);
    } else {
      this.renderHome();
    }
    if (!this.root.parentElement) document.body.appendChild(this.root);
    this.root.style.display = '';
    return new Promise<LobbyResult>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  setInvitePrefill(p: { code: string; accessKey: string; roomName?: string } | null): void {
    this.prefilledInvite = p;
  }

  // --- Common chrome ---

  private resetRoot(): void {
    this.root.innerHTML = '';
  }

  private title(text: string): void {
    const h = document.createElement('h1');
    h.textContent = text;
    this.root.appendChild(h);
  }

  private nameField(): HTMLInputElement {
    const input = document.createElement('input');
    input.placeholder = 'name (optional)';
    input.maxLength = 24;
    input.value = this.name;
    input.addEventListener('input', () => {
      this.name = input.value.trim();
    });
    return input;
  }

  private errLine(): HTMLDivElement {
    const err = document.createElement('div');
    err.className = 'err';
    return err;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.onclick = onClick;
    return b;
  }

  // --- Views ---

  private renderHome(): void {
    this.resetRoot();
    this.title('GRIDFORCE');

    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    nameRow.appendChild(this.nameField());
    this.root.appendChild(nameRow);

    this.root.appendChild(this.button('Browse public rooms', () => this.renderBrowse()));
    this.root.appendChild(this.button('Join by code', () => this.renderJoinByCode()));
    this.root.appendChild(this.button('Create new room', () => this.renderCreate()));

    this.root.appendChild(this.errLine());
  }

  private renderBrowse(): void {
    this.resetRoot();
    this.title('Public rooms');

    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '0.5rem';
    list.style.minWidth = '20rem';
    list.style.maxHeight = '14rem';
    list.style.overflowY = 'auto';
    list.textContent = 'loading…';
    this.root.appendChild(list);

    const err = this.errLine();
    this.root.appendChild(err);
    this.root.appendChild(this.button('Back', () => this.renderHome()));

    listPublicRooms()
      .then(({ rooms }) => this.populateBrowse(list, err, rooms))
      .catch((e: unknown) => {
        list.textContent = '';
        err.textContent = describeError(e);
      });
  }

  private populateBrowse(
    list: HTMLDivElement,
    err: HTMLDivElement,
    rooms: PublicRoomSummary[],
  ): void {
    list.innerHTML = '';
    if (rooms.length === 0) {
      const empty = document.createElement('div');
      empty.style.opacity = '0.7';
      empty.style.textAlign = 'center';
      empty.textContent = 'no public rooms — create one or join by code';
      list.appendChild(empty);
      return;
    }
    for (const room of rooms) {
      const row = document.createElement('button');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.minWidth = '20rem';
      const label = document.createElement('span');
      label.textContent = room.name || `Room ${room.code}`;
      const meta = document.createElement('span');
      meta.style.opacity = '0.7';
      meta.textContent = `${room.code} · ${room.players}/${room.maxPlayers}`;
      row.appendChild(label);
      row.appendChild(meta);
      const full = room.players >= room.maxPlayers;
      if (full) {
        row.disabled = true;
        meta.textContent += ' · full';
      }
      row.onclick = () => {
        err.textContent = '';
        this.beginJoin(room.code).catch((e: unknown) => {
          err.textContent = describeError(e);
        });
      };
      list.appendChild(row);
    }
  }

  private renderJoinByCode(): void {
    this.resetRoot();
    this.title('Join by code');

    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    nameRow.appendChild(this.nameField());
    this.root.appendChild(nameRow);

    const codeRow = document.createElement('div');
    codeRow.className = 'row';
    const codeInput = document.createElement('input');
    codeInput.placeholder = 'room code';
    codeInput.maxLength = 8;
    codeInput.style.textTransform = 'uppercase';
    codeRow.appendChild(codeInput);
    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Join';
    joinBtn.style.minWidth = '6rem';
    codeRow.appendChild(joinBtn);
    this.root.appendChild(codeRow);

    const err = this.errLine();
    this.root.appendChild(err);
    this.root.appendChild(this.button('Back', () => this.renderHome()));

    const submit = (): void => {
      const code = codeInput.value.trim().toUpperCase();
      if (code.length < 2) {
        err.textContent = 'enter a room code';
        return;
      }
      err.textContent = '';
      this.setFormDisabled(true);
      this.beginJoin(code).catch((e: unknown) => {
        this.setFormDisabled(false);
        err.textContent = describeError(e);
      });
    };
    joinBtn.onclick = submit;
    codeInput.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
  }

  private renderCreate(): void {
    this.resetRoot();
    this.title('Create room');

    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    nameRow.appendChild(this.nameField());
    this.root.appendChild(nameRow);

    const roomNameInput = document.createElement('input');
    roomNameInput.placeholder = 'room name (optional)';
    roomNameInput.maxLength = 32;
    this.root.appendChild(roomNameInput);

    // Visibility radio
    const visRow = document.createElement('div');
    visRow.style.display = 'flex';
    visRow.style.flexDirection = 'column';
    visRow.style.gap = '0.25rem';
    visRow.style.alignItems = 'flex-start';
    visRow.style.fontSize = '0.9rem';
    visRow.appendChild(makeRadio('vis', 'unlisted', 'Unlisted (code only)', true));
    visRow.appendChild(makeRadio('vis', 'public', 'Public (listed)'));
    visRow.appendChild(makeRadio('vis', 'private', 'Private (invite-only)'));
    this.root.appendChild(visRow);

    // Max players
    const maxRow = document.createElement('div');
    maxRow.className = 'row';
    const maxLabel = document.createElement('span');
    maxLabel.textContent = 'max players';
    maxLabel.style.alignSelf = 'center';
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.min = '1';
    maxInput.max = '4';
    maxInput.value = '4';
    maxInput.style.width = '4rem';
    maxRow.appendChild(maxLabel);
    maxRow.appendChild(maxInput);
    this.root.appendChild(maxRow);

    const err = this.errLine();
    this.root.appendChild(err);

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Create';
    this.root.appendChild(createBtn);
    this.root.appendChild(this.button('Back', () => this.renderHome()));

    createBtn.onclick = () => {
      const visibility = visRow.querySelector('input[name="vis"]:checked')?.value as
        | 'public'
        | 'unlisted'
        | 'private'
        | undefined;
      if (!visibility) return;
      const maxPlayers = Math.max(1, Math.min(4, Number(maxInput.value) || 4));
      err.textContent = '';
      this.setFormDisabled(true);
      const body: Parameters<typeof createRoom>[0] = { visibility, maxPlayers };
      const roomName = roomNameInput.value.trim();
      if (roomName) body.name = roomName;
      createRoom(body)
        .then((room) => {
          // For private rooms the server hands back a one-shot host access
          // key inline so we can walk straight into the lobby. Guest invites
          // are minted later from inside the LobbyOverlay (host-only).
          if (room.visibility === 'private' && room.hostAccessKey) {
            this.completeJoin({ code: room.code, accessKey: room.hostAccessKey });
            return;
          }
          return this.beginJoin(room.code);
        })
        .catch((e: unknown) => {
          this.setFormDisabled(false);
          err.textContent = describeError(e);
        });
    };
  }

  // Auto-join landing when the page is opened with ?inv=<token>.
  private renderInviteJoin(prefilled: {
    code: string;
    accessKey: string;
    roomName?: string;
  }): void {
    this.resetRoot();
    this.title('Joining room');

    const sub = document.createElement('div');
    sub.style.opacity = '0.7';
    sub.style.textAlign = 'center';
    sub.textContent = prefilled.roomName
      ? `${prefilled.roomName} (${prefilled.code})`
      : `code: ${prefilled.code}`;
    this.root.appendChild(sub);

    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    nameRow.appendChild(this.nameField());
    this.root.appendChild(nameRow);

    const err = this.errLine();
    this.root.appendChild(err);

    this.root.appendChild(
      this.button('Enter', () =>
        this.completeJoin({ code: prefilled.code, accessKey: prefilled.accessKey }),
      ),
    );
  }

  // --- Join flow ---

  private async beginJoin(code: string): Promise<void> {
    const access = await requestAccess(code);
    this.completeJoin(access);
  }

  private completeJoin(access: AccessResult): void {
    if (!this.resolveFn) return;
    const fn = this.resolveFn;
    this.resolveFn = null;
    this.setFormDisabled(true);
    fn({ roomCode: access.code, name: this.name, accessKey: access.accessKey });
  }

  // --- Misc ---

  private setFormDisabled(disabled: boolean): void {
    this.root.querySelectorAll('button, input').forEach((el) => {
      (el as HTMLButtonElement | HTMLInputElement).disabled = disabled;
    });
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

  // Re-show the lobby after a connection failed mid-handshake. Reset to home
  // so the user can pick a different room or retry.
  reset(): void {
    this.prefilledInvite = null;
    this.renderHome();
    if (!this.root.parentElement) document.body.appendChild(this.root);
    this.root.style.display = '';
    this.setFormDisabled(false);
  }
}

function makeRadio(name: string, value: string, label: string, checked = false): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '0.4rem';
  wrap.style.cursor = 'pointer';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = name;
  radio.value = value;
  radio.checked = checked;
  wrap.appendChild(radio);
  const span = document.createElement('span');
  span.textContent = label;
  wrap.appendChild(span);
  return wrap;
}

function describeError(e: unknown): string {
  if (e instanceof LobbyApiError) {
    switch (e.code) {
      case 'not_found':
        return 'no such room';
      case 'room_full':
        return 'room is full';
      case 'requires_invite':
        return 'this room is invite-only';
      case 'expired':
        return 'invite has expired';
      case 'exhausted':
        return 'invite has been used up';
      case 'room_gone':
        return 'room no longer exists';
      default:
        return `server: ${e.code}`;
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
