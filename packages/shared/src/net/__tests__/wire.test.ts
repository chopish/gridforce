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
  SetReadyMsg,
  SnapshotMsg,
  StartGameMsg,
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
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    roomCode: 'ABCD',
    name: 'crab',
    accessKey: 'kx7q9z',
  };
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
    phase: 'lobby' as const,
    hostId: 0,
    difficulty: 1,
    levelId: 'test-grid',
    maxPlayers: 4,
    sessionKey: 'sess-abc123',
    players: [
      { ...newPlayerState(0, 100, 100, 'alice'), facing: 1.234, stateSeq: 7 },
      { ...newPlayerState(3, 200, 250, 'bob'), facing: -0.5, stateSeq: 9, ready: true },
    ],
  };
  const decoded = decodeMessage(WelcomeMsg.encode(payload));
  assert.equal(decoded.type, MessageType.Welcome);
  const w = decoded.payload;
  assert.equal(w.yourPlayerId, 3);
  assert.deepEqual(w.grid, payload.grid);
  assert.equal(w.startTick, 1234);
  assert.equal(w.serverTimeMs, 1700000000123.5);
  assert.equal(w.phase, 'lobby');
  assert.equal(w.hostId, 0);
  assert.equal(w.difficulty, 1);
  assert.equal(w.levelId, 'test-grid');
  assert.equal(w.sessionKey, 'sess-abc123');
  assert.equal(w.players.length, 2);
  assert.equal(w.players[0]!.name, 'alice');
  assert.equal(w.players[0]!.ready, false);
  assert.equal(w.players[1]!.name, 'bob');
  assert.equal(w.players[1]!.ready, true);
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

test('Input round-trip with single input', () => {
  const input = { tick: 12345, clientTimeMs: 1700000000.25, mx: -0.5, my: 0.7, dash: true };
  const enc = InputMsg.encode([input]);
  const dec = decodeMessage(enc);
  assert.equal(dec.type, MessageType.Input);
  const list = dec.payload;
  assert.equal(list.length, 1);
  const p = list[0]!;
  assert.equal(p.tick, input.tick);
  assert.equal(p.clientTimeMs, input.clientTimeMs);
  assert.ok(Math.abs(p.mx - input.mx) < 1e-6);
  assert.ok(Math.abs(p.my - input.my) < 1e-6);
  assert.equal(p.dash, input.dash);
});

test('Input round-trip with redundancy window (3 ticks)', () => {
  const inputs = [
    { tick: 100, clientTimeMs: 1.0, mx: 1, my: 0, dash: false },
    { tick: 101, clientTimeMs: 2.0, mx: 0.5, my: 0.5, dash: true },
    { tick: 102, clientTimeMs: 3.0, mx: 0, my: -1, dash: false },
  ];
  const dec = decodeMessage(InputMsg.encode(inputs));
  assert.equal(dec.type, MessageType.Input);
  const list = dec.payload;
  assert.equal(list.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(list[i]!.tick, inputs[i]!.tick);
    assert.equal(list[i]!.dash, inputs[i]!.dash);
  }
});

test('Input encoding rejects empty + over-cap counts', () => {
  assert.throws(() => InputMsg.encode([]), /out of range/);
  const tooMany = new Array(64).fill(0).map((_, i) => ({
    tick: i,
    clientTimeMs: 0,
    mx: 0,
    my: 0,
    dash: false,
  }));
  assert.throws(() => InputMsg.encode(tooMany), /out of range/);
});

test('Snapshot round-trip with multiple players, ack bitmask, dash timers', () => {
  const players = [
    { ...newPlayerState(0, 50, 60), facing: 0, stateSeq: 1 },
    {
      ...newPlayerState(1, 70, 80),
      facing: Math.PI,
      stateSeq: 2,
      dashCooldownS: 0.4,
    },
    {
      ...newPlayerState(2, 90, 100),
      facing: -Math.PI / 2,
      stateSeq: 3,
      dashCooldownS: 0.65,
      dashRemainingS: 0.12,
    },
  ];
  const payload = {
    tick: 9999,
    serverTimeMs: 1700000000500,
    ackInputTick: 9990,
    inputAckBitmask: 0b1010_1100,
    phase: 'playing' as const,
    hostId: 0,
    difficulty: 2,
    levelId: 'test-grid',
    players,
    npcs: [],
  };
  const dec = decodeMessage(SnapshotMsg.encode(payload));
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload;
  assert.equal(s.tick, payload.tick);
  assert.equal(s.serverTimeMs, payload.serverTimeMs);
  assert.equal(s.ackInputTick, payload.ackInputTick);
  assert.equal(s.inputAckBitmask, payload.inputAckBitmask);
  assert.equal(s.phase, 'playing');
  assert.equal(s.hostId, 0);
  assert.equal(s.difficulty, 2);
  assert.equal(s.levelId, 'test-grid');
  assert.equal(s.players.length, players.length);
  // Idle player: both timers 0.
  assert.equal(s.players[0]!.dashCooldownS, 0);
  assert.equal(s.players[0]!.dashRemainingS, 0);
  // Cooling-down player: cooldown round-trips with ~4ms quantization.
  assert.ok(Math.abs(s.players[1]!.dashCooldownS - 0.4) < 0.005, 'cooldown precision');
  assert.equal(s.players[1]!.dashRemainingS, 0);
  // Mid-dash player: both timers preserved.
  assert.ok(Math.abs(s.players[2]!.dashCooldownS - 0.65) < 0.005, 'mid-dash cooldown');
  assert.ok(Math.abs(s.players[2]!.dashRemainingS - 0.12) < 0.005, 'mid-dash remaining');
});

test('Snapshot handles zero players', () => {
  const dec = decodeMessage(
    SnapshotMsg.encode({
      tick: 0,
      serverTimeMs: 0,
      ackInputTick: -1,
      inputAckBitmask: 0,
      phase: 'lobby',
      hostId: 0xff,
      difficulty: 1,
      levelId: 'test-grid',
      players: [],
      npcs: [],
    }),
  );
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload;
  assert.equal(s.players.length, 0);
  assert.equal(s.npcs.length, 0);
  assert.equal(s.ackInputTick, -1);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.hostId, 0xff);
});

test('Snapshot encodes NPC group when npcs are present', () => {
  const npcs = [
    { id: 0, x: 100, y: 200, facing: 0, flags: 0 },
    { id: 1, x: 320, y: 50, facing: Math.PI, flags: 0 },
    { id: 65535, x: -10, y: -10, facing: -Math.PI / 2, flags: 0 },
  ];
  const dec = decodeMessage(
    SnapshotMsg.encode({
      tick: 1,
      serverTimeMs: 0,
      ackInputTick: -1,
      inputAckBitmask: 0,
      phase: 'playing',
      hostId: 0,
      difficulty: 1,
      levelId: 'test-grid',
      players: [],
      npcs,
    }),
  );
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload;
  assert.equal(s.npcs.length, 3);
  for (let i = 0; i < npcs.length; i++) {
    const a = s.npcs[i]!;
    const b = npcs[i]!;
    assert.equal(a.id, b.id);
    // i16 px precision: round-trip is integer-equal after encoder rounding.
    assert.equal(a.x, Math.round(b.x));
    assert.equal(a.y, Math.round(b.y));
    // facing quantized to 8 bits → ~0.025 rad precision
    const facingDiff = Math.abs(((a.facing - b.facing + Math.PI) % (Math.PI * 2)) - Math.PI);
    assert.ok(facingDiff < 0.05, `npc facing within 0.05 rad (got ${facingDiff})`);
  }
});

test('SetReady / StartGame round-trip', () => {
  const r = decodeMessage(SetReadyMsg.encode({ ready: true }));
  assert.equal(r.type, MessageType.SetReady);
  assert.deepEqual(r.payload, { ready: true });

  const r0 = decodeMessage(SetReadyMsg.encode({ ready: false }));
  assert.equal(r0.type, MessageType.SetReady);
  assert.deepEqual(r0.payload, { ready: false });

  const sg = decodeMessage(StartGameMsg.encode({}));
  assert.equal(sg.type, MessageType.StartGame);
  assert.deepEqual(sg.payload, {});
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
  assert.equal(dj.payload.player.id, 2);

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
  const bad = new Uint8Array([/*type*/ 0x82, 0x00, /*schema*/ 0xff, 0x00]);
  assert.throws(() => decodeMessage(bad), SchemaMismatchError);
});
