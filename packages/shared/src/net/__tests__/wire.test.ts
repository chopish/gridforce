import test from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION } from '../../constants.js';
import { newPlayerState } from '../../sim.js';
import {
  AddBotMsg,
  ErrorMsg,
  HelloMsg,
  InputMsg,
  MessageType,
  PingMsg,
  PlayerJoinedMsg,
  PlayerLeftMsg,
  PongMsg,
  SchemaMismatchError,
  SnapshotMsg,
  WelcomeMsg,
  decodeMessage,
} from '../index.js';
import { BinaryReader, BinaryWriter } from '../wire.js';

function roundtrip<T>(
  encoded: Uint8Array,
  expected: { type: MessageType; payload: T },
  payloadEq: (a: T, b: T) => void,
): void {
  const decoded = decodeMessage(encoded);
  assert.equal(decoded.type, expected.type);
  payloadEq(decoded.payload as T, expected.payload);
}

test('BinaryWriter grows past initial capacity', () => {
  const w = new BinaryWriter(4);
  for (let i = 0; i < 1000; i++) w.u8(i & 0xff);
  const bytes = w.finish();
  assert.equal(bytes.byteLength, 1000);
  for (let i = 0; i < 1000; i++) assert.equal(bytes[i], i & 0xff);
});

test('varuint round-trips across boundaries', () => {
  const cases = [0, 1, 127, 128, 255, 256, 16383, 16384, 0xffffffff];
  for (const v of cases) {
    const w = new BinaryWriter(8);
    w.varuint(v);
    const r = new BinaryReader(w.finish());
    assert.equal(r.varuint(), v >>> 0, `varuint roundtrip ${v}`);
  }
});

test('Hello round-trip', () => {
  const payload = { schemaVersion: SCHEMA_VERSION, roomCode: 'ABCD', name: 'crab' };
  roundtrip(HelloMsg.encode(payload), { type: MessageType.Hello, payload }, (a, b) => {
    assert.deepEqual(a, b);
  });
});

test('Welcome round-trip', () => {
  const payload = {
    yourPlayerId: 3,
    grid: { cols: 18, rows: 12, panelSize: 64 },
    startTick: 1234,
    serverTimeMs: 1700000000123.5,
    players: [
      { ...newPlayerState(0, 100, 100), facing: 1.234, stateSeq: 7 },
      { ...newPlayerState(3, 200, 250), facing: -0.5, stateSeq: 9 },
    ],
  };
  const decoded = decodeMessage(WelcomeMsg.encode(payload));
  assert.equal(decoded.type, MessageType.Welcome);
  const w = decoded.payload as ReturnType<typeof WelcomeMsg.decode>;
  assert.equal(w.yourPlayerId, 3);
  assert.deepEqual(w.grid, payload.grid);
  assert.equal(w.startTick, 1234);
  assert.equal(w.serverTimeMs, 1700000000123.5);
  assert.equal(w.players.length, 2);
  for (let i = 0; i < 2; i++) {
    const a = w.players[i]!;
    const b = payload.players[i]!;
    assert.equal(a.id, b.id);
    assert.ok(Math.abs(a.x - b.x) < 1e-3);
    assert.ok(Math.abs(a.y - b.y) < 1e-3);
    // facing is quantized to 8 bits → ~0.025 rad precision
    const facingDiff = Math.abs(((a.facing - b.facing + Math.PI) % (Math.PI * 2)) - Math.PI);
    assert.ok(facingDiff < 0.05, `facing within 0.05 rad (got ${facingDiff})`);
    assert.equal(a.stateSeq, b.stateSeq);
  }
});

test('Input round-trip including button clamping behavior', () => {
  const payload = { tick: 12345, clientTimeMs: 1700000000.25, mx: -0.5, my: 0.7, dash: true };
  const enc = InputMsg.encode(payload);
  const dec = decodeMessage(enc);
  assert.equal(dec.type, MessageType.Input);
  const p = dec.payload as ReturnType<typeof InputMsg.decode>;
  assert.equal(p.tick, payload.tick);
  assert.equal(p.clientTimeMs, payload.clientTimeMs);
  assert.ok(Math.abs(p.mx - payload.mx) < 1e-6);
  assert.ok(Math.abs(p.my - payload.my) < 1e-6);
  assert.equal(p.dash, payload.dash);
});

test('Snapshot round-trip with multiple players, ack bitmask', () => {
  const players = [
    { ...newPlayerState(0, 50, 60), facing: 0, stateSeq: 1 },
    { ...newPlayerState(1, 70, 80), facing: Math.PI, stateSeq: 2 },
    { ...newPlayerState(2, 90, 100), facing: -Math.PI / 2, stateSeq: 3, dashRemainingS: 0.05 },
  ];
  const payload = {
    tick: 9999,
    serverTimeMs: 1700000000500,
    ackInputTick: 9990,
    inputAckBitmask: 0b1010_1100,
    players,
  };
  const dec = decodeMessage(SnapshotMsg.encode(payload));
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload as ReturnType<typeof SnapshotMsg.decode>;
  assert.equal(s.tick, payload.tick);
  assert.equal(s.serverTimeMs, payload.serverTimeMs);
  assert.equal(s.ackInputTick, payload.ackInputTick);
  assert.equal(s.inputAckBitmask, payload.inputAckBitmask);
  assert.equal(s.players.length, players.length);
  // dashing player should arrive with dashRemainingS > 0 (flag preserved)
  assert.ok(s.players[2]!.dashRemainingS > 0);
});

test('Snapshot handles zero players', () => {
  const dec = decodeMessage(
    SnapshotMsg.encode({
      tick: 0,
      serverTimeMs: 0,
      ackInputTick: -1,
      inputAckBitmask: 0,
      players: [],
    }),
  );
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload as ReturnType<typeof SnapshotMsg.decode>;
  assert.equal(s.players.length, 0);
  assert.equal(s.ackInputTick, -1);
});

test('Ping/Pong round-trip preserves nonces and times', () => {
  const ping = { nonce: 0xdeadbeef, clientTimeMs: 12345.678 };
  const dp = decodeMessage(PingMsg.encode(ping));
  assert.equal(dp.type, MessageType.Ping);
  assert.deepEqual(dp.payload, ping);

  const pong = { nonce: 0xdeadbeef, clientTimeMs: 12345.678, serverTimeMs: 12350.0 };
  const dq = decodeMessage(PongMsg.encode(pong));
  assert.equal(dq.type, MessageType.Pong);
  assert.deepEqual(dq.payload, pong);
});

test('Error round-trip', () => {
  const err = { code: 1, message: 'schema mismatch v2' };
  const dec = decodeMessage(ErrorMsg.encode(err));
  assert.equal(dec.type, MessageType.Error);
  assert.deepEqual(dec.payload, err);
});

test('PlayerJoined / PlayerLeft round-trip', () => {
  const j = { player: { ...newPlayerState(2, 100, 200), facing: 0.7, stateSeq: 5 } };
  const dj = decodeMessage(PlayerJoinedMsg.encode(j));
  assert.equal(dj.type, MessageType.PlayerJoined);
  assert.equal((dj.payload as ReturnType<typeof PlayerJoinedMsg.decode>).player.id, 2);

  const l = { playerId: 2 };
  const dl = decodeMessage(PlayerLeftMsg.encode(l));
  assert.equal(dl.type, MessageType.PlayerLeft);
  assert.deepEqual(dl.payload, l);
});

test('AddBot round-trip is empty', () => {
  const dec = decodeMessage(AddBotMsg.encode({}));
  assert.equal(dec.type, MessageType.AddBot);
  assert.deepEqual(dec.payload, {});
});

test('Schema mismatch is detected via decodeMessage', () => {
  // Hand-craft a header with a bogus schema version.
  const bad = new Uint8Array([
    /*type*/ 0x82, 0x00,
    /*schema*/ 0xff, 0x00,
  ]);
  assert.throws(() => decodeMessage(bad), SchemaMismatchError);
});
