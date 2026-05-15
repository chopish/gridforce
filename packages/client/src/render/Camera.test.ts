import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './Camera.js';

test('camera centres immediately at first sample', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 2304, worldH: 1536 });
  cam.snapTo(1152, 768);
  const { x, y } = cam.position;
  assert.equal(x, 1152);
  assert.equal(y, 768);
});

test('camera smooths toward target over time', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 2304, worldH: 1536 });
  cam.snapTo(0, 0);
  cam.update(1000, 1000, 0.05); // 50ms of catch-up toward (1000, 1000)
  const after = cam.position;
  assert.ok(after.x > 0 && after.x < 1000, `x partway toward 1000 (got ${after.x})`);
  assert.ok(after.y > 0 && after.y < 1000);
});

test('camera clamps to world bounds', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 2304, worldH: 1536 });
  cam.snapTo(0, 0);
  // Target way off the left edge; over many updates, the position should
  // converge to a value that does not let the viewport reveal void.
  for (let i = 0; i < 200; i++) cam.update(-100, -100, 1 / 30);
  const { x, y } = cam.position;
  // Min camera position is viewportW/2 (so left edge of viewport is x=0).
  assert.equal(x, 400);
  assert.equal(y, 300);
});

test('camera centres when world is smaller than viewport in either axis', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 400, worldH: 1536 });
  cam.snapTo(0, 0);
  for (let i = 0; i < 200; i++) cam.update(10000, 1500, 1 / 30);
  // World narrower than viewport in x → camera locks to world centre on x.
  assert.equal(cam.position.x, 200);
  // y still tracks the target (clamped to world bounds).
  assert.ok(cam.position.y > 0);
});


test('camera update with dt <= 0 is a no-op', () => {
  const cam = new Camera({ viewportW: 800, viewportH: 600, worldW: 2304, worldH: 1536 });
  cam.snapTo(500, 500);
  cam.update(1000, 1000, 0);
  assert.equal(cam.position.x, 500);
  assert.equal(cam.position.y, 500);
  cam.update(1000, 1000, -1);
  assert.equal(cam.position.x, 500);
  assert.equal(cam.position.y, 500);
});
