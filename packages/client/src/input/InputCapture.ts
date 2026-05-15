// Captures keyboard + gamepad and exposes a snapshot the prediction loop can
// sample once per tick. WASD / arrow keys map to mx/my; space is dash.
//
// Dash is rising-edge: a press flags the next several sampled ticks as
// dash=true. Sending the dash flag for multiple consecutive ticks survives
// individual packet loss — the server only honours the first one (cooldown
// gates the rest), so duplicate dashes are not a concern.
//
// Shock follows the same rising-edge pattern (F / LMB / gamepad B2).
// Repair is held-state (R / RMB / gamepad B3).

// How many ticks to keep dash/shock=true after a press. At 5% loss, 1 tick
// has 5% miss rate; 3 ticks drops it to 0.0125%. Tradeoff: extra latency-of-
// dash/shock if user spams, but cooldown gating means at most one per cooldown.
const DASH_PRESS_TICKS = 3;
const SHOCK_PRESS_TICKS = 3;

export interface InputSnapshot {
  mx: number;
  my: number;
  dash: boolean;
  sprint: boolean;
  shock: boolean;
  repair: boolean;
}

export class InputCapture {
  private up = false;
  private down = false;
  private left = false;
  private right = false;
  private sprint = false;
  private repair = false;
  private dashTicksRemaining = 0;
  private shockTicksRemaining = 0;

  // Mouse state. mouseLeftEdge is consumed once per sample() call (rising-edge).
  private mouseLeftEdge = false;
  private mouseRightHeld = false;

  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseLeftEdge = true;
    if (e.button === 2) this.mouseRightHeld = true;
  };
  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.mouseRightHeld = false;
  };
  private readonly onContextMenu = (e: Event): void => {
    // Suppress the browser context menu so right-click can be used as the
    // repair held-key without the menu popping up mid-game.
    e.preventDefault();
  };

  constructor() {
    this.onKey = (e: KeyboardEvent) => {
      const pressed = e.type === 'keydown';
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.up = pressed;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.down = pressed;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.left = pressed;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.right = pressed;
          break;
        case 'Space':
          if (pressed) this.dashTicksRemaining = DASH_PRESS_TICKS;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.sprint = pressed;
          break;
        case 'KeyF':
          // Shock rising-edge. F was previously used for netsim-cycle; that
          // has been moved to KeyP in main.ts (B1 electrical-defense).
          if (pressed) this.shockTicksRemaining = SHOCK_PRESS_TICKS;
          break;
        case 'KeyR':
          this.repair = pressed;
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    this.onBlur = () => this.clear();

    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
  }

  // Returns the input for this tick and clears any rising-edge latches.
  sample(): InputSnapshot {
    let mx = 0;
    let my = 0;
    if (this.left) mx -= 1;
    if (this.right) mx += 1;
    if (this.up) my -= 1;
    if (this.down) my += 1;

    // Gamepad overrides keyboard if connected and any axis is non-trivial.
    const pad = navigator.getGamepads?.()[0];
    let sprintPressed = false;
    let gamepadShockPressed = false;
    let gamepadRepairHeld = false;
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.15) {
        mx = ax;
        my = ay;
      }
      if ((pad.buttons[0]?.pressed ?? false) || (pad.buttons[7]?.pressed ?? false)) {
        this.dashTicksRemaining = DASH_PRESS_TICKS;
      }
      sprintPressed = pad.buttons[6]?.pressed ?? false;
      // B2 = shock rising-edge (matches keyboard F / mouse LMB pattern).
      // B3 = repair held (matches keyboard R / mouse RMB pattern).
      if (pad.buttons[2]?.pressed ?? false) {
        this.shockTicksRemaining = SHOCK_PRESS_TICKS;
      }
      gamepadShockPressed = pad.buttons[2]?.pressed ?? false;
      gamepadRepairHeld = pad.buttons[3]?.pressed ?? false;
    }

    // Normalise diagonal so we don't ship 1.41 to the server.
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }

    const dash = this.dashTicksRemaining > 0;
    if (this.dashTicksRemaining > 0) this.dashTicksRemaining--;

    const shock = this.shockTicksRemaining > 0 || this.mouseLeftEdge || gamepadShockPressed;
    if (this.shockTicksRemaining > 0) this.shockTicksRemaining--;
    // Consume the mouse left rising-edge latch now that it has been read.
    this.mouseLeftEdge = false;

    return {
      mx,
      my,
      dash,
      sprint: this.sprint || sprintPressed,
      shock,
      repair: this.repair || this.mouseRightHeld || gamepadRepairHeld,
    };
  }

  clear(): void {
    this.up = this.down = this.left = this.right = this.sprint = false;
    this.repair = false;
    this.dashTicksRemaining = 0;
    this.shockTicksRemaining = 0;
    this.mouseLeftEdge = false;
    this.mouseRightHeld = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
  }
}
