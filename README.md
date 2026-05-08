# GridForce

Browser-based 1–4 player cooperative game. Aerial-perspective horde defense
on a solar-panel grid. **Phase 0** — engine + netcode foundation. Only
movement and dash exist; no combat, no panel mechanics, no scoring.

This repo is the foundation; gameplay design lands on top of it.

## Status

| Layer | State |
| ----- | ----- |
| Authoritative server + client prediction + reconciliation | Working |
| Snapshot interpolation (remotes + NPCs, adaptive jitter buffer) | Working |
| Binary wire format, schema-versioned | v9 |
| Transport: WebSocket + WebRTC DataChannel with fallback | Working |
| Lobby: public / unlisted / private + host-managed invites + ready-up | Working |
| Wandering NPCs (server-side, for stress tests; not gameplay) | Working |
| Combat, panels, electrodes, scoring | Not started |

## Quick start

```bash
npm install
npm run dev          # spins up server (:8080) and client (Vite, :5173)
```

Open `http://localhost:5173`. Create a room, copy the code, open another tab,
join. The debug HUD (top-right) shows tick, RTT, prediction error, transport
in use, and netsim profile. `F` cycles netsim profiles; `N` / `J` / `K`
spawn NPCs; `B` adds a bot.

## Repo layout

This is an npm workspaces monorepo. Three packages, each independently
buildable and testable.

| Package | Role |
| ------- | ---- |
| `packages/shared` | Pure deterministic game sim, wire format, constants, NetSim. Both server and client depend on this; it depends on nothing. |
| `packages/server` | Express + ws server. Authoritative tick loop, room manager, lobby/invite stores, transport adapters, integration tests. |
| `packages/client` | Vite + PixiJS browser client. Prediction, reconciliation, interpolation, render, lobby UI, debug HUD. |
| `tools/deploy` | Auto-deploy webhook receiver + systemd units + nginx config for the GCP VM. See `tools/deploy/README.md`. |

## Commands

Run from the repo root unless noted.

```bash
npm run dev          # server + client concurrently with hot reload
npm run dev:server   # server only
npm run dev:client   # client only
npm run build        # all packages
npm run typecheck    # all packages
npm test             # all packages (22 shared + 29 server tests; client has none yet)
```

Per-package: `npm test --workspace=@gridforce/server`.

## Where to start reading

If you're new to the codebase:

1. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the layered model
   (transport → multiplexer → socket → world → render), how the tick loop
   fits together, and where extension points live.
2. **`packages/shared/src/constants.ts`** — every tunable in one file with
   commentary on why each value is what it is.
3. **`packages/shared/src/net/`** — wire format. One file per message
   type; round-trip tested in `__tests__/wire.test.ts`.
4. **`packages/server/src/Room.ts`** — the per-room physics + snapshot
   loop. The shape of every future feature lives here.
5. **`packages/client/src/sim/PredictedWorld.ts`** — local prediction
   and reconciliation; the most subtle code in the project.
6. **`packages/client/src/main.ts`** — the bootstrap and render loop;
   shows the order in which all the above plug together.

## Deployment

Pushed to `main` → GitHub webhook → VM pulls, builds, restarts. Details in
[`tools/deploy/README.md`](tools/deploy/README.md), including the WebRTC
UDP firewall config.

## Conventions

- TypeScript strict mode plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Don't loosen these.
- Bump `SCHEMA_VERSION` (in `packages/shared/src/constants.ts`) on any
  wire-format change. The Hello handshake checks it; mismatched clients
  see an explicit error rather than silently misdecoding.
- ESM throughout; relative imports use `.js` extensions.
- Constants live in `shared/constants.ts`. Magic numbers in the rest of
  the code should be a code-review smell.
