import test from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION } from '../../constants.js';
import { PanelState, allLive } from '../../panels.js';
import type { PlayerState } from '../../types.js';
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
import { PlayerEncoder } from '../entities/PlayerEncoder.js';
import { BinaryReader, BinaryWriter } from '../wire.js';

// Local helper to avoid importing sim.js (which has unresolved imports until
// Tasks 13/14 land). Equivalent to sim.ts#newPlayerState.
function newPlayerState(id: number, x: number, y: number, name = ''): PlayerState {
  return {
    id,
    x,
    y,
    facing: 0,
    facingCursorRad: 0,
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name,
    ready: false,
    carbon: 0,
    shockCooldownS: 0,
    repairProgressS: 0,
    shockHeldS: 0,
  };
}

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
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 0,
    maxPlayers: 4,
    sessionKey: 'sess-abc123',
    players: [
      { ...newPlayerState(0, 100, 100, 'alice'), facing: 1.234, stateSeq: 7 },
      { ...newPlayerState(3, 200, 250, 'bob'), facing: -0.5, stateSeq: 9, ready: true },
    ],
    panelStates: allLive(18, 12),
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
  assert.equal(w.runId, 'test-run');
  assert.equal(w.currentStageIndex, 0);
  assert.equal(w.currentPhaseIndex, 0);
  assert.equal(w.phaseElapsedS, 0);
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
  const input = {
    tick: 12345, clientTimeMs: 1700000000.25, mx: -0.5, my: 0.7,
    shock: false, repair: false,
    jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0,
  };
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
  assert.equal(p.shock, input.shock);
  assert.equal(p.repair, input.repair);
});

test('Input round-trip with redundancy window (3 ticks)', () => {
  const inputs = [
    { tick: 100, clientTimeMs: 1.0, mx: 1, my: 0, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    { tick: 101, clientTimeMs: 2.0, mx: 0.5, my: 0.5, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    { tick: 102, clientTimeMs: 3.0, mx: 0, my: -1, shock: false, repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
  ];
  const dec = decodeMessage(InputMsg.encode(inputs));
  assert.equal(dec.type, MessageType.Input);
  const list = dec.payload;
  assert.equal(list.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(list[i]!.tick, inputs[i]!.tick);
  }
});

test('Input round-trip preserves shock + repair bits', () => {
  const inputs = [
    { tick: 300, clientTimeMs: 1, mx: 0, my: 0, shock: true,  repair: false, jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    { tick: 301, clientTimeMs: 2, mx: 0, my: 0, shock: false, repair: true,  jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
    { tick: 302, clientTimeMs: 3, mx: 0, my: 0, shock: true,  repair: true,  jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0, facingRad: 0 },
  ];
  const dec = decodeMessage(InputMsg.encode(inputs));
  assert.equal(dec.type, MessageType.Input);
  const list = dec.payload;
  assert.equal(list.length, 3);
  assert.equal(list[0]!.shock, true);
  assert.equal(list[0]!.repair, false);
  assert.equal(list[1]!.shock, false);
  assert.equal(list[1]!.repair, true);
  assert.equal(list[2]!.shock, true);
  assert.equal(list[2]!.repair, true);
});

test('Input v13 round-trip preserves jumpHeld + cursor offsets + facing + shock-held', () => {
  const inputs = [
    {
      tick: 500, clientTimeMs: 1, mx: 0.1, my: -0.2,
      shock: true, repair: false,
      jumpHeld: true, jumpCursorDx: 1, jumpCursorDy: -2,
      facingRad: Math.PI / 2,
    },
    {
      tick: 501, clientTimeMs: 2, mx: 0, my: 0,
      shock: false, repair: true,
      jumpHeld: false, jumpCursorDx: 0, jumpCursorDy: 0,
      facingRad: 0,
    },
  ];
  const dec = decodeMessage(InputMsg.encode(inputs));
  assert.equal(dec.type, MessageType.Input);
  const list = dec.payload;
  assert.equal(list.length, 2);
  assert.equal(list[0]!.shock, true);
  assert.equal(list[0]!.repair, false);
  assert.equal(list[0]!.jumpHeld, true);
  assert.equal(list[0]!.jumpCursorDx, 1);
  assert.equal(list[0]!.jumpCursorDy, -2);
  assert.ok(Math.abs(list[0]!.facingRad - Math.PI / 2) < 0.05);
  assert.equal(list[1]!.repair, true);
  assert.equal(list[1]!.jumpHeld, false);
});

test('Input encoder clamps jumpCursor offsets to ±PANEL_JUMP_TARGET_RANGE', () => {
  const inputs = [{
    tick: 1, clientTimeMs: 0, mx: 0, my: 0,
    shock: false, repair: false,
    jumpHeld: true, jumpCursorDx: 99, jumpCursorDy: -99,
    facingRad: 0,
  }];
  const dec = decodeMessage(InputMsg.encode(inputs));
  assert.equal(dec.type, MessageType.Input);
  const got = dec.payload[0]!;
  assert.equal(got.jumpCursorDx, 2);
  assert.equal(got.jumpCursorDy, -2);
});

test('Input encoding rejects empty + over-cap counts', () => {
  assert.throws(() => InputMsg.encode([]), /out of range/);
  const tooMany = new Array(64).fill(0).map((_, i) => ({
    tick: i,
    clientTimeMs: 0,
    mx: 0,
    my: 0,
    shock: false,
    repair: false,
    jumpHeld: false,
    jumpCursorDx: 0,
    jumpCursorDy: 0,
    facingRad: 0,
  }));
  assert.throws(() => InputMsg.encode(tooMany), /out of range/);
});

test('Snapshot round-trip with cooldown timer', () => {
  const players = [
    { ...newPlayerState(0, 50, 60), facing: 0, stateSeq: 1 },
    { ...newPlayerState(1, 70, 80), facing: Math.PI, stateSeq: 2, panelJumpCooldownS: 0.4 },
    { ...newPlayerState(2, 90, 100), facing: -Math.PI / 2, stateSeq: 3, panelJumpCooldownS: 0.65 },
  ];
  const payload = {
    tick: 9999,
    serverTimeMs: 1700000000500,
    ackInputTick: 9990,
    inputAckBitmask: 0b1010_1100,
    phase: 'playing' as const,
    hostId: 0,
    difficulty: 2,
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 1.25,
    players,
    npcs: [],
    crawlers: [],
    carbons: [],
    panelStates: allLive(18, 12),
    panelCols: 18,
    panelRows: 12,
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
  assert.equal(s.runId, 'test-run');
  assert.equal(s.currentStageIndex, 0);
  assert.equal(s.currentPhaseIndex, 0);
  // f32 precision: round-trip should be exact for this value.
  assert.ok(Math.abs(s.phaseElapsedS - 1.25) < 1e-6);
  assert.equal(s.players.length, players.length);
  // Idle player: cooldown is 0.
  assert.equal(s.players[0]!.panelJumpCooldownS, 0);
  // Cooling-down player: cooldown round-trips with ~4ms quantization.
  assert.ok(Math.abs(s.players[1]!.panelJumpCooldownS - 0.4) < 0.005, 'cooldown precision');
  // Second cooling-down player: cooldown precision.
  assert.ok(Math.abs(s.players[2]!.panelJumpCooldownS - 0.65) < 0.005, 'cooldown precision');
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
      runId: 'test-run',
      currentStageIndex: 0,
      currentPhaseIndex: 0,
      phaseElapsedS: 0,
      players: [],
      npcs: [],
      crawlers: [],
      carbons: [],
      panelStates: allLive(18, 12),
      panelCols: 18,
      panelRows: 12,
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
      runId: 'test-run',
      currentStageIndex: 0,
      currentPhaseIndex: 0,
      phaseElapsedS: 0,
      players: [],
      npcs,
      crawlers: [],
      carbons: [],
      panelStates: allLive(18, 12),
      panelCols: 18,
      panelRows: 12,
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

test('PlayerEncoder preserves repairProgressS up to REPAIR_DURATION_S without clipping', () => {
  const players = [
    {
      ...newPlayerState(0, 100, 100, 'a'),
      facing: 0,
      stateSeq: 1,
      carbon: 0,
      shockCooldownS: 0,
      repairProgressS: 1.5,
    },
  ];
  const dec = decodeMessage(SnapshotMsg.encode({
    tick: 1, serverTimeMs: 0, ackInputTick: -1, inputAckBitmask: 0,
    phase: 'playing', hostId: 0, difficulty: 1,
    runId: 'test-run', currentStageIndex: 0, currentPhaseIndex: 0, phaseElapsedS: 0,
    players, npcs: [], crawlers: [], carbons: [],
    panelStates: allLive(18, 12), panelCols: 18, panelRows: 12,
  }));
  assert.equal(dec.type, MessageType.Snapshot);
  const got = dec.payload.players[0]!.repairProgressS;
  assert.ok(Math.abs(got - 1.5) < 0.03, `expected ~1.5s, got ${got}`);
});

test('PlayerEncoder round-trips carbon + shockCooldownS + repairProgressS', () => {
  const players = [
    {
      ...newPlayerState(0, 100, 100, 'a'),
      facing: 0,
      stateSeq: 1,
      carbon: 5,
      shockCooldownS: 0.15,
      repairProgressS: 0.8,
    },
    {
      ...newPlayerState(1, 200, 200, 'b'),
      facing: 0,
      stateSeq: 2,
      carbon: 99,
      shockCooldownS: 0,
      repairProgressS: 0,
    },
  ];
  const dec = decodeMessage(SnapshotMsg.encode({
    tick: 1,
    serverTimeMs: 0,
    ackInputTick: -1,
    inputAckBitmask: 0,
    phase: 'playing',
    hostId: 0,
    difficulty: 1,
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 0,
    players,
    npcs: [],
    crawlers: [],
    carbons: [],
    panelStates: allLive(18, 12),
    panelCols: 18,
    panelRows: 12,
  }));
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload;
  assert.equal(s.players[0]!.carbon, 5);
  assert.ok(Math.abs(s.players[0]!.shockCooldownS - 0.15) < 0.01, 'shock cooldown quantization');
  assert.ok(Math.abs(s.players[0]!.repairProgressS - 0.8) < 0.01, 'repair progress quantization');
  assert.equal(s.players[1]!.carbon, 99);
});

test('Snapshot carries panel-state RLE block', () => {
  const panelBuf = allLive(18, 12);
  panelBuf[0] = PanelState.DAMAGED;
  panelBuf[5] = PanelState.BROKEN;
  const dec = decodeMessage(SnapshotMsg.encode({
    tick: 1,
    serverTimeMs: 0,
    ackInputTick: -1,
    inputAckBitmask: 0,
    phase: 'playing',
    hostId: 0,
    difficulty: 1,
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 0,
    players: [],
    npcs: [],
    crawlers: [],
    carbons: [],
    panelStates: panelBuf,
    panelCols: 18,
    panelRows: 12,
  }));
  assert.equal(dec.type, MessageType.Snapshot);
  const s = dec.payload;
  assert.equal(s.panelStates.length, 18 * 12);
  assert.equal(s.panelStates[0], PanelState.DAMAGED);
  assert.equal(s.panelStates[5], PanelState.BROKEN);
  assert.equal(s.panelStates[1], PanelState.LIVE);
});

test('CarbonEncoder round-trips Carbon state', async () => {
  const { CarbonEncoder } = await import('../entities/CarbonEncoder.js');
  const c = { id: 7, x: 500, y: 700, ttlS: 5.5 };
  const w = new BinaryWriter(16);
  CarbonEncoder.encode(w, c);
  const r = new BinaryReader(w.finish());
  const decoded = CarbonEncoder.decode(r);
  assert.equal(decoded.id, 7);
  assert.equal(decoded.x, 500);
  assert.equal(decoded.y, 700);
  assert.ok(Math.abs(decoded.ttlS - 5.5) < 0.1, `ttl quantization (got ${decoded.ttlS})`);
});

test('CrawlerEncoder round-trips Crawler state', async () => {
  const { CrawlerEncoder } = await import('../entities/CrawlerEncoder.js');
  const c = { id: 42, x: 320.5, y: 200, facing: Math.PI / 2, hp: 1, targetCx: 5, targetCy: 6, ai: 1 as const };
  const w = new BinaryWriter(32);
  CrawlerEncoder.encode(w, c);
  const r = new BinaryReader(w.finish());
  const decoded = CrawlerEncoder.decode(r);
  assert.equal(decoded.id, 42);
  assert.equal(decoded.hp, 1);
  assert.equal(decoded.targetCx, 5);
  assert.equal(decoded.targetCy, 6);
  assert.equal(decoded.ai, 1);
  assert.ok(Math.abs(decoded.x - 320) <= 1, 'x int round-trip');
  assert.ok(Math.abs(decoded.y - 200) <= 1, 'y int round-trip');
});

test('Welcome carries full panel-state byte array', () => {
  const panelBuf = allLive(18, 12);
  panelBuf[10] = PanelState.DAMAGED;
  const decoded = decodeMessage(WelcomeMsg.encode({
    yourPlayerId: 0,
    grid: { cols: 18, rows: 12, panelSize: 64 },
    startTick: 0,
    serverTimeMs: 0,
    phase: 'lobby',
    hostId: 0,
    difficulty: 1,
    runId: 'test-run',
    currentStageIndex: 0,
    currentPhaseIndex: 0,
    phaseElapsedS: 0,
    maxPlayers: 4,
    sessionKey: '',
    players: [],
    panelStates: panelBuf,
  }));
  assert.equal(decoded.type, MessageType.Welcome);
  const w = decoded.payload;
  assert.equal(w.panelStates.length, 18 * 12);
  assert.equal(w.panelStates[10], PanelState.DAMAGED);
});

test('PlayerEncoder v13 round-trips facingCursorRad and shockHeldS', () => {
  const p: PlayerState = {
    id: 7, x: 100, y: 200,
    facing: 0,
    facingCursorRad: Math.PI,
    panelJumpCooldownS: 0,
    stateSeq: 0,
    name: 'a', ready: false,
    carbon: 5, shockCooldownS: 0, repairProgressS: 0,
    shockHeldS: 0.42,
  };
  const w = new BinaryWriter(64);
  PlayerEncoder.encode(w, p);
  const buf = w.finish();
  const r = new BinaryReader(buf);
  const back = PlayerEncoder.decode(r);
  assert.ok(Math.abs(back.facingCursorRad - Math.PI) < 0.05);
  assert.ok(Math.abs(back.shockHeldS - 0.42) < 0.02);
});
