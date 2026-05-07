# GridForce

Online co-op grid-defense arcade game. **Phase 0:** engine + netcode foundation only — no gameplay yet.

## Stack

- **Client:** Pixi.js v8 + Vite (TypeScript)
- **Server:** Node + ws + Express (TypeScript), 30 Hz authoritative tick
- **Shared:** deterministic simulation package imported by both
- **Architecture:** server-authoritative + client prediction + reconciliation, with remote-entity interpolation

## Quick start

```sh
npm install
npm run dev
```

That launches the server on `:8080` and the client (Vite) on `:5173`. Open `http://localhost:5173` in two browser windows to test multiplayer locally.

## Layout

```
packages/
  shared/   # Pure sim, types, wire protocol — used by both client and server
  client/   # Pixi renderer, input, prediction loop, lobby UI
  server/   # WS server, room manager, authoritative tick, bots
```

## What works in Phase 0

- Two players move around analog-style on a shared grid
- Server is authoritative; client predicts local input and reconciles against snapshots
- Remote players are interpolated 100 ms behind the latest snapshot
- Room codes for join flow; idle bots fill empty slots
- Debug HUD shows ping, tick, prediction error
- Deterministic sim verified by replay tool

## What does not work yet (intentionally)

Anything gameplay: shock, electrodes, repair, enemies, waves, art, audio, progression, persistence. Phase 1 starts those.
