// CameraController — follow + zoom + screen/world conversion (C1 Task 19).
//
// Replaces the older `Camera` (which clamped to world bounds and had no zoom).
// The renderer applies the camera transform to its world container each frame:
//
//   worldContainer.scale.set(camera.zoomLevel);
//   const sc = camera.worldToScreen({ x: 0, y: 0 });
//   worldContainer.position.set(sc.x, sc.y);
//
// main.ts and InputCapture rely on `screenToWorld` to convert mouse cursor
// screen position to world position for cursor-derived facing.
//
// Smoothing is frame-rate-independent exponential easing toward the target
// with time constant CAMERA_FOLLOW_SMOOTH_S. Zoom is multiplicative by
// CAMERA_ZOOM_STEP per scroll notch, clamped to [CAMERA_ZOOM_MIN,
// CAMERA_ZOOM_MAX].

import {
  CAMERA_FOLLOW_SMOOTH_S,
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_MIN,
  CAMERA_ZOOM_STEP,
} from '@gridforce/shared';

export interface CameraOpts {
  viewportW: number;
  viewportH: number;
}

export class CameraController {
  center = { x: 0, y: 0 };
  zoomLevel = 1.0;
  private target = { x: 0, y: 0 };
  private viewportW: number;
  private viewportH: number;
  private followEnabled = true;

  constructor(opts: CameraOpts) {
    this.viewportW = opts.viewportW;
    this.viewportH = opts.viewportH;
  }

  setViewportSize(w: number, h: number): void {
    this.viewportW = w;
    this.viewportH = h;
  }

  setTarget(t: { x: number; y: number }): void {
    this.target = { x: t.x, y: t.y };
  }

  zoom(notches: number): void {
    const factor = Math.pow(CAMERA_ZOOM_STEP, notches);
    this.zoomLevel = Math.max(
      CAMERA_ZOOM_MIN,
      Math.min(CAMERA_ZOOM_MAX, this.zoomLevel * factor),
    );
  }

  recenter(): void {
    this.followEnabled = true;
  }

  /**
   * Free-pan the camera by a screen-space delta. Disables follow until
   * `recenter()` is called. Screen delta is converted to world delta by the
   * inverse of `zoomLevel`, so panning feels consistent across zoom levels.
   */
  pan(dxScreen: number, dyScreen: number): void {
    this.followEnabled = false;
    // Screen delta → world delta (inverse zoom).
    this.center.x -= dxScreen / this.zoomLevel;
    this.center.y -= dyScreen / this.zoomLevel;
  }

  /**
   * Teleport the camera center to a world-space point and disable follow
   * until `recenter()` is called.
   */
  setCenter(pos: { x: number; y: number }): void {
    this.followEnabled = false;
    this.center.x = pos.x;
    this.center.y = pos.y;
  }

  update(dt: number): void {
    if (!this.followEnabled) return;
    if (dt <= 0) return;
    // Exponential smoothing toward the target.
    const t = 1 - Math.exp(-dt / CAMERA_FOLLOW_SMOOTH_S);
    this.center.x += (this.target.x - this.center.x) * t;
    this.center.y += (this.target.y - this.center.y) * t;
  }

  worldToScreen(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (p.x - this.center.x) * this.zoomLevel + this.viewportW / 2,
      y: (p.y - this.center.y) * this.zoomLevel + this.viewportH / 2,
    };
  }

  screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (p.x - this.viewportW / 2) / this.zoomLevel + this.center.x,
      y: (p.y - this.viewportH / 2) / this.zoomLevel + this.center.y,
    };
  }
}
