// Captures keyboard + gamepad and exposes a snapshot the prediction loop can
// sample once per tick. WASD / arrow keys map to mx/my; space is dash.
//
// Dash is rising-edge: a press flags the next several sampled ticks as
// dash=true. Sending the dash flag for multiple consecutive ticks survives
// individual packet loss — the server only honours the first one (cooldown
// gates the rest), so duplicate dashes are not a concern.

// How many ticks to keep dash=true after a press. At 5% loss, 1 tick has 5%
// miss rate; 3 ticks drops it to 0.0125%. Tradeoff: extra latency-of-dash if
// user spams, but cooldown gating means at most one dash per cooldown.
const DASH_PRESS_TICKS = 3;

export interface InputSnapshot {
  mx: number;
  my: number;
  dash: boolean;
  sprint: boolean;
}

export class InputCapture {
  private up = false;
  private down = false;
  private left = false;
  private right = false;
  private dashTicksRemaining = 0;

  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;

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
        default:
          return;
      }
      e.preventDefault();
    };
    this.onBlur = () => this.clear();

    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
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
    }

    // Normalise diagonal so we don't ship 1.41 to the server.
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }

    const dash = this.dashTicksRemaining > 0;
    if (this.dashTicksRemaining > 0) this.dashTicksRemaining--;
    return { mx, my, dash, sprint: false };
  }

  clear(): void {
    this.up = this.down = this.left = this.right = false;
    this.dashTicksRemaining = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
  }
}
