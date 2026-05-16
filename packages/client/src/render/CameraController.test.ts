import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraController } from './CameraController.js';

test('CameraController follows the target with smoothing', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 0, y: 0 });
  cam.update(1.0); // 1 second — well past smoothing time constant (0.18s)
  assert.ok(Math.abs(cam.center.x - 0) < 1);
  cam.setTarget({ x: 1000, y: 0 });
  cam.update(1.0);
  assert.ok(cam.center.x > 900);
});

test('CameraController zoom clamps to min/max', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.zoom(10);
  assert.ok(cam.zoomLevel <= 2.0);
  cam.zoom(-10);
  assert.ok(cam.zoomLevel >= 0.5);
});

test('screenToWorld inverts worldToScreen', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 500, y: 300 });
  cam.update(10.0); // converge fully
  const screen = cam.worldToScreen({ x: 500, y: 300 });
  // Centered target is at viewport center.
  assert.ok(Math.abs(screen.x - 400) < 1);
  assert.ok(Math.abs(screen.y - 300) < 1);
  const world = cam.screenToWorld(screen);
  assert.ok(Math.abs(world.x - 500) < 1);
  assert.ok(Math.abs(world.y - 300) < 1);
});

test('setViewportSize updates internal dims used by worldToScreen', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  cam.setViewportSize(1024, 768);
  const screen = cam.worldToScreen({ x: 0, y: 0 });
  assert.ok(Math.abs(screen.x - 512) < 1);
  assert.ok(Math.abs(screen.y - 384) < 1);
});

test('zoom affects screenToWorld correctly', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  cam.zoom(1); // one notch in: zoomLevel ~1.1
  const worldA = cam.screenToWorld({ x: 800, y: 600 });
  cam.zoom(-10); // zoom out a lot
  const worldB = cam.screenToWorld({ x: 800, y: 600 });
  // At lower zoom, the same screen pos maps to a world point farther from center.
  assert.ok(Math.abs(worldB.x) > Math.abs(worldA.x));
});

test('pan disables follow until recenter', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  cam.pan(100, 0); // pan 100 px right (screen) = center moves left 100 world
  assert.ok(cam.center.x < 0);
  // setTarget should NOT pull camera back while panning.
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  assert.ok(cam.center.x < 0);
  // Recenter brings follow back.
  cam.recenter();
  cam.update(10.0);
  assert.ok(Math.abs(cam.center.x) < 1);
});

test('setCenter teleports camera and disables follow', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  cam.setCenter({ x: 500, y: 300 });
  assert.equal(cam.center.x, 500);
  assert.equal(cam.center.y, 300);
  cam.setTarget({ x: 0, y: 0 });
  cam.update(10.0);
  assert.equal(cam.center.x, 500); // follow disabled — no pull
});

test('edge-pan moves camera when enabled and cursor is at edge', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 500, y: 300 });
  cam.update(10.0);
  const startX = cam.center.x;
  cam.setEdgePanEnabled(true);
  cam.updateEdgePan({ x: 5, y: 300 }, 0.1); // cursor far left
  assert.ok(cam.center.x < startX);
});

test('edge-pan is a no-op when disabled', () => {
  const cam = new CameraController({ viewportW: 800, viewportH: 600 });
  cam.setTarget({ x: 500, y: 300 });
  cam.update(10.0);
  const startX = cam.center.x;
  // edgePanEnabled defaults to false.
  cam.updateEdgePan({ x: 5, y: 300 }, 0.1);
  assert.equal(cam.center.x, startX);
});
