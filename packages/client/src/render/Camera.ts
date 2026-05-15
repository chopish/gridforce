const TIME_CONSTANT_S = 0.12;

export interface CameraOptions {
  viewportW: number;
  viewportH: number;
  worldW: number;
  worldH: number;
}

export class Camera {
  private x = 0;
  private y = 0;
  private opts: CameraOptions;

  constructor(opts: CameraOptions) {
    this.opts = opts;
  }

  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  resize(viewportW: number, viewportH: number): void {
    this.opts = { ...this.opts, viewportW, viewportH };
  }

  setWorldBounds(worldW: number, worldH: number): void {
    this.opts = { ...this.opts, worldW, worldH };
  }

  snapTo(targetX: number, targetY: number): void {
    const { x, y } = this.clamp(targetX, targetY);
    this.x = x;
    this.y = y;
  }

  update(targetX: number, targetY: number, dtS: number): void {
    if (dtS <= 0) return;
    // Frame-rate-independent exponential smoothing.
    const alpha = 1 - Math.exp(-dtS / TIME_CONSTANT_S);
    const clamped = this.clamp(targetX, targetY);
    this.x = this.x + (clamped.x - this.x) * alpha;
    this.y = this.y + (clamped.y - this.y) * alpha;
  }

  /** World→screen offset to apply to the playfield container. */
  worldToScreenOffset(): { x: number; y: number } {
    return {
      x: this.opts.viewportW / 2 - this.x,
      y: this.opts.viewportH / 2 - this.y,
    };
  }

  private clamp(targetX: number, targetY: number): { x: number; y: number } {
    const { viewportW, viewportH, worldW, worldH } = this.opts;
    const halfW = viewportW / 2;
    const halfH = viewportH / 2;
    // If the world is narrower than the viewport in some axis, lock that
    // axis to world centre. Otherwise clamp the camera so the viewport
    // stays inside the world.
    let x: number;
    if (worldW <= viewportW) x = worldW / 2;
    else x = Math.max(halfW, Math.min(worldW - halfW, targetX));
    let y: number;
    if (worldH <= viewportH) y = worldH / 2;
    else y = Math.max(halfH, Math.min(worldH - halfH, targetY));
    return { x, y };
  }
}
