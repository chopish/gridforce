// Captures keyboard + mouse + gamepad and exposes a snapshot the prediction
// loop can sample once per tick.
//
// v13 changes vs B1:
//   - Sprint capture is dropped entirely (Shift is now the jump-target modal).
//   - Dash rising-edge counter is dropped (panel-jump replaces dash and the
//     server reads jumpHeld held-state directly).
//   - Shock is held-state (F / LMB held → shock=true). No rising-edge latch;
//     the server tracks how long the bit has been continuously set to drive
//     the charged-shock charge meter.
//   - Repair stays held-state (R / RMB held → repair=true).
//   - Cursor-derived facing: while a mousemove listener tracks the cursor's
//     screen position, the renderer supplies a screen→world callback so
//     sample() can compute facingRad = atan2(cursor - localPlayer) per tick.
//   - Jump-targeting modal: while ShiftLeft/ShiftRight is held, WASD keys are
//     CONSUMED as cursor-tile offsets (clamped to ±PANEL_JUMP_TARGET_RANGE
//     per axis). Movement vector is forced to zero during jump-hold so the
//     player can't walk while picking a jump target. The server applies the
//     jump on the falling edge of jumpHeld (key release).

import type { PlayerInput } from '@gridforce/shared';
import { PANEL_JUMP_TARGET_RANGE } from '@gridforce/shared';

export type SampledInput = Omit<PlayerInput, 'tick' | 'clientTimeMs'>;

export class InputCapture {
  // WASD held-state.
  private up = false;
  private down = false;
  private left = false;
  private right = false;

  // Held action bits.
  private shockHeld = false;
  private repairHeld = false;

  // Mouse held-state. LMB → shock, RMB → repair.
  private mouseLeftHeld = false;
  private mouseRightHeld = false;

  // Cursor tracking. Screen coords are updated on every mousemove; world coords
  // are resolved lazily via the renderer-supplied callback so we don't have to
  // poke a CameraController dependency into this module.
  private mouseScreenX = 0;
  private mouseScreenY = 0;
  private getCursorWorldPos: (() => { x: number; y: number }) | null = null;
  private facingRad = 0;

  // Jump-target modal state.
  private jumpHeld = false;
  private jumpCursorDx = 0;
  private jumpCursorDy = 0;

  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  private readonly onMouseMove = (e: MouseEvent): void => {
    this.mouseScreenX = e.clientX;
    this.mouseScreenY = e.clientY;
  };
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseLeftHeld = true;
    if (e.button === 2) this.mouseRightHeld = true;
  };
  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseLeftHeld = false;
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
          if (pressed && this.jumpHeld) {
            // Jump-modal: W nudges cursor up by one tile, clamped.
            this.jumpCursorDy = Math.max(-PANEL_JUMP_TARGET_RANGE, this.jumpCursorDy - 1);
          } else {
            this.up = pressed;
          }
          break;
        case 'KeyS':
        case 'ArrowDown':
          if (pressed && this.jumpHeld) {
            this.jumpCursorDy = Math.min(PANEL_JUMP_TARGET_RANGE, this.jumpCursorDy + 1);
          } else {
            this.down = pressed;
          }
          break;
        case 'KeyA':
        case 'ArrowLeft':
          if (pressed && this.jumpHeld) {
            this.jumpCursorDx = Math.max(-PANEL_JUMP_TARGET_RANGE, this.jumpCursorDx - 1);
          } else {
            this.left = pressed;
          }
          break;
        case 'KeyD':
        case 'ArrowRight':
          if (pressed && this.jumpHeld) {
            this.jumpCursorDx = Math.min(PANEL_JUMP_TARGET_RANGE, this.jumpCursorDx + 1);
          } else {
            this.right = pressed;
          }
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          if (pressed) {
            // Entering jump-modal: reset cursor offset and zero held WASD so
            // the player doesn't walk for a frame on jump release.
            if (!this.jumpHeld) {
              this.jumpCursorDx = 0;
              this.jumpCursorDy = 0;
            }
            this.jumpHeld = true;
            this.up = this.down = this.left = this.right = false;
          } else {
            // Releasing Shift is the trigger the server reads as "execute
            // the jump." We leave jumpCursorDx/Dy intact so the falling-edge
            // sample carries the final target offset.
            this.jumpHeld = false;
          }
          break;
        case 'KeyF':
          // F is held-state shock (matches LMB). Server tracks held-duration
          // for the charged-shock charge meter.
          this.shockHeld = pressed;
          break;
        case 'KeyR':
          this.repairHeld = pressed;
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
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
  }

  // Wired by main.ts once the CameraController is built (Task 17). The
  // callback returns the cursor's current world-space position; we keep the
  // dependency one-way so InputCapture has no direct reference to the camera.
  setCursorWorldPosCallback(fn: () => { x: number; y: number }): void {
    this.getCursorWorldPos = fn;
  }

  // Read-only cursor screen coords — exposed so the renderer can compute
  // world coords on demand if it wants to share the resolved point.
  getMouseScreenX(): number {
    return this.mouseScreenX;
  }
  getMouseScreenY(): number {
    return this.mouseScreenY;
  }

  // Jump-overlay accessors (Task 22). The overlay draws a tile-highlight at
  // localPlayer + (dx, dy) tiles while jumpHeld is true.
  isJumpHeld(): boolean {
    return this.jumpHeld;
  }
  getJumpCursorDx(): number {
    return this.jumpCursorDx;
  }
  getJumpCursorDy(): number {
    return this.jumpCursorDy;
  }

  private updateFacingFromCursor(localPlayerPos: { x: number; y: number }): void {
    if (!this.getCursorWorldPos) return;
    const c = this.getCursorWorldPos();
    this.facingRad = Math.atan2(c.y - localPlayerPos.y, c.x - localPlayerPos.x);
  }

  private computeMoveX(): number {
    let mx = 0;
    if (this.left) mx -= 1;
    if (this.right) mx += 1;
    return mx;
  }

  private computeMoveY(): number {
    let my = 0;
    if (this.up) my -= 1;
    if (this.down) my += 1;
    return my;
  }

  // Returns the input for this tick. localPlayerPos is the predicted world
  // position of the local player (used to compute cursor-relative facing).
  // Defaults to origin so this remains callable before the renderer wires
  // up the cursor callback (Task 17 wires both).
  sample(localPlayerPos: { x: number; y: number } = { x: 0, y: 0 }): SampledInput {
    this.updateFacingFromCursor(localPlayerPos);

    let mx = this.jumpHeld ? 0 : this.computeMoveX();
    let my = this.jumpHeld ? 0 : this.computeMoveY();

    // Gamepad overrides keyboard if connected and any axis is non-trivial.
    // Gamepad is suppressed during jump-modal for the same reason WASD is —
    // we don't want the player walking while picking a jump target.
    const pad = navigator.getGamepads?.()[0];
    let gamepadShockHeld = false;
    let gamepadRepairHeld = false;
    if (pad) {
      if (!this.jumpHeld) {
        const ax = pad.axes[0] ?? 0;
        const ay = pad.axes[1] ?? 0;
        if (Math.hypot(ax, ay) > 0.15) {
          mx = ax;
          my = ay;
        }
      }
      // B2 = shock held, B3 = repair held.
      gamepadShockHeld = pad.buttons[2]?.pressed ?? false;
      gamepadRepairHeld = pad.buttons[3]?.pressed ?? false;
    }

    // Normalise diagonal so we don't ship 1.41 to the server.
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }

    return {
      mx,
      my,
      shock: this.shockHeld || this.mouseLeftHeld || gamepadShockHeld,
      repair: this.repairHeld || this.mouseRightHeld || gamepadRepairHeld,
      jumpHeld: this.jumpHeld,
      jumpCursorDx: this.jumpCursorDx,
      jumpCursorDy: this.jumpCursorDy,
      facingRad: this.facingRad,
    };
  }

  clear(): void {
    this.up = this.down = this.left = this.right = false;
    this.shockHeld = false;
    this.repairHeld = false;
    this.mouseLeftHeld = false;
    this.mouseRightHeld = false;
    this.jumpHeld = false;
    this.jumpCursorDx = 0;
    this.jumpCursorDy = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
  }
}
