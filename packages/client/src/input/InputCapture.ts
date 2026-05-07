// Captures keyboard + gamepad and exposes a snapshot the prediction loop can
// sample once per tick. WASD / arrow keys map to mx/my; space is dash.
//
// Dash is rising-edge: latched on press until consumed by the next sampled
// tick. This avoids the double-fire / miss problems that happen when input
// rate doesn't match sim rate.

export interface InputSnapshot {
  mx: number;
  my: number;
  dash: boolean;
}

export class InputCapture {
  private up = false;
  private down = false;
  private left = false;
  private right = false;
  private dashLatched = false;

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
          if (pressed) this.dashLatched = true;
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
        this.dashLatched = true;
      }
    }

    // Normalise diagonal so we don't ship 1.41 to the server.
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }

    const dash = this.dashLatched;
    this.dashLatched = false;
    return { mx, my, dash };
  }

  clear(): void {
    this.up = this.down = this.left = this.right = false;
    this.dashLatched = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
  }
}
