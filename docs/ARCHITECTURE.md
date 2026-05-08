# GridForce architecture

The job of this document: get a new contributor productive without making
them reverse-engineer the codebase. Read top to bottom for the mental
model; jump to "Extension points" when adding things.

## Mental model in one paragraph

A GridForce server runs an authoritative simulation in fixed-rate ticks.
Clients run the same simulation locally, predicting forward from the latest
authoritative state and replaying their own un-acknowledged inputs each
time a snapshot lands. When server and client disagree past a threshold,
the simulation rebases hard and the *visual* position smoothly catches
up — so prediction errors don't manifest as rubber-banding. Remote
players and NPCs render on a buffer-and-delay interpolator, not from
prediction. All wire traffic is binary, schema-versioned, and split
across two channels: a reliable WebSocket for control / lobby /
handshake, and an unreliable WebRTC DataChannel (with WebSocket
fallback) for snapshots and inputs.

## Layered overview

```
                     ┌────────────────────────────────────┐
                     │  packages/shared (no deps)         │
                     │  - sim.ts (deterministic stepPlayer)│
                     │  - net/wire.ts + messages/* + entities/* │
                     │  - constants.ts (every tunable)    │
                     │  - netsim.ts (TCP-HOL / UDP modes) │
                     └────────────────────────────────────┘
                              ▲                    ▲
                              │                    │
       ┌──────────────────────┘                    └────────────────────┐
       │                                                                 │
┌──────────────────────────┐                              ┌──────────────────────────┐
│ packages/server           │                              │ packages/client           │
│                           │                              │                           │
│  server.ts ─ HTTP + WS    │                              │  main.ts ─ bootstrap loop │
│   ├ httpRoutes.ts         │                              │   ├ Socket → MultiTransport│
│   ├ wsHandler.ts          │                              │   │   ├ WebSocketTransport│
│   │   └ Connection ──┐    │                              │   │   └ WebRtcTransport   │
│   │                  │    │                              │   ├ PredictedWorld        │
│   ├ RoomManager      │    │                              │   ├ RemotePlayerInterpolator│
│   │   └ Room ──── tick loop, broadcastSnapshot           │   ├ NpcInterpolator       │
│   ├ transport/       │    │                              │   ├ Renderer (Pixi)       │
│   │   ├ MultiTransport│   │                              │   └ Lobby + LobbyOverlay  │
│   │   ├ WebSocketTransport                               │                           │
│   │   ├ WebRtcTransport (libdatachannel)                 │                           │
│   │   └ RtcPeer (handshake orchestrator)                 │                           │
│   └ test/headless integration                            │                           │
└──────────────────────────┘                              └──────────────────────────┘
```

The shared package has no runtime dependencies on either server or client.
This is load-bearing: changes to shared get tested in isolation, and the
deterministic sim is reusable on both sides without sneaking environment
assumptions across.

## The tick loop (server-side)

The work happens in `Room.ts`. Per room, a single `setInterval` drives a
self-correcting loop:

1. **Physics tick** at `SERVER_TICK_HZ` (currently 30 Hz). Reads the next
   queued input for each pilot, calls `stepPlayer` from
   `shared/src/sim.ts`, advances NPCs.
2. **Snapshot broadcast** at `SERVER_SNAPSHOT_HZ` (20 Hz). The two are
   intentionally decoupled: physics needs to be precise, snapshots only
   need to be frequent enough for interpolation. When the loop falls
   behind it catches up to the physics target up to `MAX_CATCHUP_PHYSICS_TICKS`
   sub-ticks; further behind triggers a clamp so the room can't spiral.

`broadcastSnapshot` runs each pilot through an **AOI hook** (currently a
passthrough) before encoding. When per-client culling ships, the hook
returns a per-pilot subset and snapshots become per-pilot encodes. Today
the encoded buffer is reused across all pilots for a single allocation
per snapshot.

Snapshots send on the **unreliable** channel. Older snapshots are
worthless once a newer one arrives, so loss + drop-and-replace beats
TCP retransmission of stale state. Inputs likewise — and inputs carry
**redundancy**: each Input message contains the last `INPUT_REDUNDANCY`
ticks, so a single dropped packet doesn't lose a frame as long as the
next gets through. The server dedupes by tick.

## Client prediction & reconciliation

Client side, `PredictedWorld.step` is called once per tick from the
fixed-step accumulator in `main.ts`. It samples input, advances the
local player through the same `stepPlayer` the server uses, and queues
the input for `Socket.sendInput`.

`PredictedWorld.applySnapshot` runs when a server snapshot arrives:

1. Drop pending inputs with tick ≤ `ackInputTick`.
2. Rebase the local player to the server's authoritative position.
3. Replay the remaining pending inputs.
4. Compare the rebased simulation position to what we were *displaying*.
   - delta < `PREDICTION_THRESHOLD_PX` (5 px) → no correction. The rebase
     is invisible.
   - delta < `PREDICTION_HARD_SNAP_PX` (30 px) → the simulated position
     updates immediately, but a `correctionVector` is stored and the
     **rendered** position is blended toward truth over
     `PREDICTION_BLEND_MS` (150 ms). This kills rubber-banding.
   - delta ≥ `PREDICTION_HARD_SNAP_PX` → hard snap; logged as a divergence
     event in `diagnostics.hardSnaps`.

Render also interpolates between the previous and current predicted
states based on `accumulator / SERVER_TICK_DT_MS`, so visuals advance at
display refresh rate while the sim advances at 30 Hz.

The local player **adapts its prediction lead**. `INPUT_LEAD_TICKS = 5`
seeds it; each frame, `setTargetLead(oneWayTicks + 6)` reacts to RTT.
The +6 tick margin is jitter headroom; with less, individual late
packets cause the server to idle for a tick and produce ~7 px
divergences that smooth-correction can't catch up between snapshots.

## Remote players and NPCs

Local prediction is wrong for entities that aren't us. They render on a
**buffer-and-delay interpolator**:

- `RemotePlayerInterpolator` and `NpcInterpolator` both keep the last
  several snapshots and render at `now() - delayMs`, where `delayMs` is
  adaptive (`REMOTE_INTERP_DELAY_MIN_MS` to `REMOTE_INTERP_DELAY_MAX_MS`,
  seeded at 100 ms, adjusted toward `p95(jitter) × 2`).
- On underflow (no snapshot at render time), `RemotePlayerInterpolator`
  dead-reckons forward using the last known velocity for up to
  `REMOTE_INTERP_DEAD_RECKON_MAX_MS` (200 ms). NPC interpolator currently
  freezes; their wandering velocity changes too erratically for dead
  reckoning to help.
- On overflow (buffer growing), they smoothly speed up at
  `REMOTE_INTERP_CATCHUP_RATE` (1.05×) until back at target.
- Tab-visibility-restore resets both buffers — the buffered snapshots
  are minutes old and would visibly catch-up-jump.

## Wire format

`packages/shared/src/net/`:

```
net/
├── wire.ts              ─ BinaryReader / Writer, varuint, primitives
├── index.ts             ─ MessageType enum + decodeMessage dispatcher + barrel
├── messages/<Name>.ts   ─ one file per message; each exports { encode, decode }
├── entities/PlayerEncoder.ts ─ ~16 bytes per player
├── entities/NpcEncoder.ts    ─ ~10 bytes per NPC
└── entities/registry.ts ─ EntityType → encoder map (hooks for future entities)
```

Header is `u16 messageType + u16 schemaVersion`. Anything that fails to
match `SCHEMA_VERSION` from `constants.ts` is rejected by the receiver
and surfaces an `Error` message. Bumping the schema requires:

1. Increment `SCHEMA_VERSION`.
2. Add a one-line history entry to the comment above it.
3. Update `wire.test.ts` round-trips for any changed messages.

`Snapshot.ts` carries `tick`, `serverTimeMs`, `ackInputTick`,
`inputAckBitmask` (recovers from individual lost ack), then a list of
`(entityType, count, [encoded entities])`. Per-entity flag byte reserves
one bit for "delta-from-baseline"; not used yet but lets us turn deltas
on without breaking the schema.

## Transport

Two layers: `Transport` (a uniform interface) and `MultiTransport` (a
composite that owns a control + optional data transport).

```
                Socket
                  │ send(bytes, channel)
                  ▼
            MultiTransport ────────────► WebSocketTransport (always)
                  │       routes
                  └─────────────────────► WebRtcTransport (when DC open)
                       channel='unreliable'
```

- **Control channel (always WS)**: handshake (Hello/Welcome), lobby
  (SetReady, SetLobbySettings), invites, RTC signalling, ping/pong.
- **Data channel (RTC if open, WS fallback)**: snapshots, inputs.

The RTC handshake is server-offerer. After `commitJoin` in `wsHandler`,
the server creates an `RtcPeer` (libdatachannel). The first action on
the wrapped `RTCPeerConnection` is to create a single DataChannel
(`unordered: true, maxRetransmits: 0`); that triggers libdatachannel's
auto-negotiation, fires `onLocalDescription`, and the offer is sent over
the existing WebSocket as an `RtcOffer`. The browser answers, ICE
candidates trickle both ways via `RtcIce`. When the channel opens, both
ends `attachDataTransport` and unreliable sends migrate.

If the handshake fails or UDP is blocked: nothing breaks. MultiTransport
never gets an open data transport, unreliable sends stay on WS. The HUD's
`xport` line stays at `websocket`. This is a deliberate failure mode —
no error path is required in application code.

`NetSim` (used in dev and tests) is **transport-aware**: in `udp` mode,
drops are real and packets are independently delayed (matches RTC). In
`tcp-hol` mode, packets serialize through `nextReadyAt` and a "lost"
packet adds one RTT to the head of the queue, blocking everything
behind (matches a TCP retransmit). The client uses both: WS path gets
tcp-hol, RTC path gets udp. This is what makes the dev simulator
visibly favor RTC under loss.

## Lobby

Two phases per room: `lobby` and `playing`. The first joiner becomes
host; if the host leaves, the lowest-id remaining human takes over
(bots can't host).

Visibility:

- **public** — listed in the `GET /api/rooms` browse endpoint.
- **unlisted** — accessible by code, not listed.
- **private** — accessible only via single-use **invite tokens**, which
  the host generates from inside the lobby. Invite redemption hands the
  client a one-shot **access key** that authenticates the WS join.

`SessionStore` issues a per-pilot `sessionKey` in the Welcome payload
when a client successfully joins. The host uses theirs to authenticate
host-gated HTTP calls (`POST /api/rooms/:code/invites`) — there's no
password concept. `AccessKeyStore` and `InviteStore` are TTL-pruned
in-memory maps; both `start()`/`stop()` from `server.ts`.

In lobby phase, movement is frozen server-side and the client ignores
keyboard input (so a desync isn't visible as "trying to walk against an
invisible wall"). `StartGame` is host-only and idempotent.

## Render

PixiJS. `Renderer` owns three sub-renderers: grid, players, NPCs. Render
is the only consumer of *visual* positions, and they come from:

- **Local player**: `world.visualLocalPosition(alpha)` — interpolation
  between the previous and current predicted states, plus the active
  smooth-correction blend.
- **Remote players**: `world.remoteInterp.sample(id, now)` — the
  buffered interpolator.
- **NPCs**: `world.forEachNpcRender(now, draw)` — same model,
  `NpcInterpolator`.

The render loop never reads the simulation directly, which keeps the
"sim is for correctness, render is for smoothness" boundary clean.

## Extension points

### Add a new wire message

1. Bump `SCHEMA_VERSION` in `shared/src/constants.ts` (with a history
   line). All connected clients become incompatible — that's intended.
2. Add the type to the `MessageType` enum in `shared/src/net/index.ts`.
3. Create `shared/src/net/messages/YourMessage.ts` exporting
   `{ encode, decode }`. Look at `SetReady.ts` for a minimal example.
4. Add the message to `DecodedMessage` and the `decodeMessage` switch
   in `shared/src/net/index.ts`.
5. Round-trip test in `shared/src/net/__tests__/wire.test.ts`.
6. Server: handle in `Connection.handleMessage` (or `wsHandler` for
   pre-Welcome cases like `RtcAnswer`/`RtcIce`).
7. Client: handle in `Socket.dispatch` (signalling) or in your game
   listener via `socket.addListener` (gameplay).

### Add a new entity type

1. Bump `SCHEMA_VERSION` and write the history line.
2. Create `shared/src/net/entities/YourEncoder.ts` implementing
   `EntityEncoder<YourState>`. Mirror `NpcEncoder.ts` for shape.
3. Register it in `shared/src/net/entities/registry.ts` against a fresh
   `EntityType` value.
4. Extend `Snapshot.encode/decode` to include the new group when present.
5. Server: simulate the entity inside `Room`. Add a Map<id, instance>
   parallel to `npcs`, step it inside `physicsStep`, push refs into
   `broadcastSnapshot`'s entity array.
6. Client: on snapshot, route the entity group into a new map on
   `PredictedWorld`. If the entity should render with delay (it
   probably should), add an interpolator parallel to `NpcInterpolator`.

### Add a new HTTP endpoint

`packages/server/src/httpRoutes.ts` is the surface. Auth-by-session-key
endpoints follow the pattern in `POST /api/rooms/:code/invites`: pull
the `Authorization: Bearer <sessionKey>` header, look up
`SessionStore.get`, verify `session.playerId === room.hostId`, then act.

## Tick rates and timing budget (current values)

| Constant | Value | What |
| -------- | ----- | ---- |
| `SERVER_TICK_HZ` | 30 | Physics steps / second |
| `SERVER_SNAPSHOT_HZ` | 20 | Broadcasts / second |
| Browser render | vsync | Interpolates between two predicted states |
| `INPUT_LEAD_TICKS` | 5 | Initial prediction lead |
| `MAX_INPUT_LEAD_TICKS` | 30 | Hard cap (poison-resistance) |
| `INPUT_REDUNDANCY` | 3 | Inputs per packet (redundancy window) |
| `PREDICTION_THRESHOLD_PX` | 5 | Below this → ignore correction |
| `PREDICTION_HARD_SNAP_PX` | 30 | Above this → hard snap, log it |
| `PREDICTION_BLEND_MS` | 150 | Smooth-correction duration |
| `REMOTE_INTERP_DELAY_SEED_MS` | 100 | Initial render-behind delay |
| `RTT_OUTLIER_MS` | 3000 | Above this RTT → discard sample |

All are in `shared/src/constants.ts` with commentary on *why* each is
what it is. Edit there, not at call sites.

## Tests

| Suite | Where | What |
| ----- | ----- | ---- |
| Wire round-trip | `shared/src/net/__tests__/wire.test.ts` | Every message encodes/decodes |
| Sim determinism | `shared/src/sim.test.ts` | `stepPlayer` is bit-exact reproducible |
| Server unit | `server/src/Connection.test.ts` | Input buffer / ack model |
| Lobby integration | `server/src/test/lobby*.test.ts` | Invites, host gates, visibility |
| Headless integration | `server/src/test/integration.headless.test.ts` | Four `TestClient` bots through the network simulator across the off / good / fair / bad matrix; asserts bandwidth, divergence, ack rate |

`TestClient.ts` is the shape an integration test uses: a real WebSocket
to a real server, with optional per-client `NetSim`. WebRTC isn't
exercised at the wire level — `TestClient` ignores `RtcOffer` and the
server transparently falls back to WebSocket. The transport abstraction
itself is currently unit-test-light; that's a known gap.

## Determinism

`shared/src/sim.ts:stepPlayer` is the pure deterministic core; same
input, same state, same `dt`, same grid → same output. The replay
test in `sim.test.ts` enforces this. **Do not introduce wall-clock
reads, RNG, or floating-point drift sources into `sim.ts`.** RNG that
needs to live in the sim should use `mulberry32` from `shared/src/rng.ts`
seeded explicitly.

## What's intentionally not designed yet

These are deferred and marked here so a contributor doesn't waste time
inferring intent that isn't there:

- **Action sync model** (shock / repair / electrode discharge / magnet /
  reinforce). Wire format and tick model are designed to support it; the
  actions themselves are unspecified.
- **AOI filter implementation**. Hook is in place at
  `Room.broadcastSnapshot`; today it's a passthrough.
- **NPC sim is server-only**. Wandering NPCs don't need prediction. When
  combat NPCs land and they need fast feedback, decide then between
  client-side prediction and tighter snapshot rate.
- **Reconnect / mid-round join / spectator mode**. Disconnect tears down
  the pilot today.
- **Bit-exact determinism / fixed-point math**. Out of scope; we're not
  doing rollback netcode.
- **WebTransport**. Phase 3 in the original plan; not started. WebRTC
  DataChannel covers the same use case, so this is a convenience win
  (no STUN/ICE), not a correctness improvement.
