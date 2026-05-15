import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelState, allLive, encodeRle, decodeRle } from './panels.js';
import { BinaryWriter, BinaryReader } from './net/wire.js';

test('allLive returns a buffer filled with LIVE', () => {
  const buf = allLive(36, 24);
  assert.equal(buf.length, 36 * 24);
  for (let i = 0; i < buf.length; i++) assert.equal(buf[i], PanelState.LIVE);
});

test('RLE round-trips a fully-LIVE grid', () => {
  const buf = allLive(36, 24);
  const w = new BinaryWriter(64);
  encodeRle(w, buf);
  const r = new BinaryReader(w.finish());
  const decoded = decodeRle(r, buf.length);
  assert.deepEqual(Array.from(decoded), Array.from(buf));
});

test('RLE round-trips a mixed grid with multiple runs', () => {
  const buf = new Uint8Array(20);
  // Pattern: 5 LIVE, 3 DAMAGED, 4 BROKEN, 8 LIVE
  for (let i = 0; i < 5; i++) buf[i] = PanelState.LIVE;
  for (let i = 5; i < 8; i++) buf[i] = PanelState.DAMAGED;
  for (let i = 8; i < 12; i++) buf[i] = PanelState.BROKEN;
  for (let i = 12; i < 20; i++) buf[i] = PanelState.LIVE;
  const w = new BinaryWriter(32);
  encodeRle(w, buf);
  const r = new BinaryReader(w.finish());
  const decoded = decodeRle(r, buf.length);
  assert.deepEqual(Array.from(decoded), Array.from(buf));
});

test('RLE compresses a fully-LIVE 36x24 grid to a tiny payload', () => {
  const buf = allLive(36, 24);
  const w = new BinaryWriter(32);
  encodeRle(w, buf);
  // One run for 864 cells: varuint(1) [runCount] + u8(state=LIVE) + varuint(864) [runLen] = ~4 bytes.
  assert.ok(w.finish().byteLength < 16, `expected <16 bytes, got ${w.finish().byteLength}`);
});
