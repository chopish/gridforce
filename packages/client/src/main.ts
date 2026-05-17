import {
  AddBotMsg,
  CAMERA_EDGE_PAN_DEFAULT,
  CLIENT_MAX_FRAME_DT_S,
  MessageType,
  NETSIM_PROFILES,
  PANEL_SIZE,
  SERVER_TICK_DT_MS,
  SHOCK_CHARGE_COOLDOWN_S,
  SHOCK_CHARGE_FULL_S,
  SHOCK_COOLDOWN_S,
  SHOCK_LINGER_S,
  SHOCK_LINGER_TICKS,
  traceShockBeam,
  type PlayerId,
} from '@gridforce/shared';

import { createInvite, redeemInvite, LobbyApiError } from './api.js';
import { InputCapture } from './input/InputCapture.js';
import { Socket } from './net/Socket.js';
import { Renderer } from './render/Renderer.js';
import { PredictedWorld } from './sim/PredictedWorld.js';
import { DebugHud } from './ui/DebugHud.js';
import { Lobby } from './ui/Lobby.js';
import { LobbyOverlay } from './ui/LobbyOverlay.js';
import { GameHud } from './ui/GameHud.js';
import { StageHud } from './ui/StageHud.js';

bootstrap().catch((err) => {
  console.error('[gridforce] fatal:', err);
});

async function bootstrap(): Promise<void> {
  const appHost = document.getElementById('app');
  if (!appHost) throw new Error('#app missing');

  const lobby = new Lobby(appHost);

  // ?inv=<token> — redeem before showing the lobby so the user lands on a
  // simple "name + Enter" prompt instead of having to navigate the picker.
  // Failed redemption falls through to the normal lobby with an error shown.
  const url = new URL(window.location.href);
  const inviteToken = url.searchParams.get('inv');
  if (inviteToken) {
    try {
      const access = await redeemInvite(inviteToken);
      lobby.setInvitePrefill({ code: access.code, accessKey: access.accessKey });
    } catch (err) {
      console.warn('[lobby] invite redeem failed:', err);
    }
    // Strip the param so a refresh doesn't double-burn the invite (the access
    // key is single-use already, but the token would 404/expire on refresh).
    url.searchParams.delete('inv');
    window.history.replaceState({}, '', url.toString());
  }

  const { roomCode, name, accessKey } = await lobby.show();

  const socket = new Socket();
  const world = new PredictedWorld();
  const inputs = new InputCapture();
  const renderer = new Renderer();

  // Tiles the client has predicted electrified but the server may not yet have
  // confirmed. applySnapshot replaces world.tiles wholesale, so a snapshot
  // authored BEFORE the server processed our shot wipes the predicted charge —
  // tile appears to light then go dark for ~RTT before lighting again.
  // After each applySnapshot we re-apply any entry whose predictedTick is
  // still ahead of the server's tick. Entries are pruned once acknowledged or
  // after a max age (covers the case where the server rejected the shot, e.g.
  // due to clock skew on the cooldown gate).
  interface PendingShock {
    idx: number;
    tick: number;
    firedAtMs: number;
  }
  const pendingShocks: PendingShock[] = [];
  let hud: DebugHud | null = null;
  let stageHud: StageHud | null = null;
  let gameHud: GameHud | null = null;
  let codeBanner: HTMLElement | null = null;
  const lobbyOverlay = new LobbyOverlay({
    onToggleReady: (next) => socket.sendSetReady(next),
    onStartGame: () => socket.sendStartGame(),
    onChangeRun: (runId) => socket.sendLobbySettings(runId, world.difficulty),
    onChangeDifficulty: (d) => socket.sendLobbySettings(world.runId, d),
    onGenerateInvite: async (uses) => {
      const sessionKey = socket.status().sessionKey;
      if (!sessionKey) throw new Error('not connected yet');
      try {
        const inv = await createInvite(roomCode, sessionKey, { maxUses: uses });
        return `${window.location.origin}${window.location.pathname}?inv=${inv.token}`;
      } catch (e) {
        if (e instanceof LobbyApiError) {
          if (e.code === 'host_only')
            throw new Error('only the host can create invites', { cause: e });
          throw new Error(`server: ${e.code}`, { cause: e });
        }
        throw e;
      }
    },
  });

  socket.connect({ roomCode, name, accessKey });

  let welcomeReceived = false;

  const off = socket.addListener((m) => {
    switch (m.type) {
      case MessageType.Welcome:
        welcomeReceived = true;
        lobby.hide();
        world.initFromWelcome(m.payload);
        renderer
          .init(appHost, m.payload.grid)
          .then(() => {
            renderer.playerRenderer.setLocalPlayer(world.localPlayerId);
            // Wire cursor screen→world conversion through the camera. Task 17
            // will use facingRad in the input sample once we feed the local
            // player's predicted world pos into sample(); this callback is
            // the link InputCapture needs to resolve cursor world coords.
            inputs.setCursorWorldPosCallback(() => {
              const cam = renderer.camera;
              if (!cam) return { x: 0, y: 0 };
              return cam.screenToWorld({
                x: inputs.getMouseScreenX(),
                y: inputs.getMouseScreenY(),
              });
            });
            hud = new DebugHud();
            stageHud = new StageHud();
            gameHud = new GameHud();
            codeBanner = lobby.showRoomCode(roomCode || 'NEW');
            startLoop();
          })
          .catch((err) => console.error('[render] init:', err));
        break;
      case MessageType.Snapshot:
        world.applySnapshot(m.payload);
        // Re-apply any predicted shock the server hasn't yet processed. The
        // applySnapshot above replaced world.tiles with the server's view, so
        // the predicted l1Charge for tiles whose fire-tick is still in our
        // lead window would have been wiped — without this re-apply the panel
        // would visibly go dark for ~RTT until an acknowledging snapshot
        // catches up. Prune acknowledged + expired entries in the same pass.
        if (pendingShocks.length > 0) {
          const nowMs = performance.now();
          const MAX_AGE_MS = SHOCK_LINGER_S * 1000 + 500;
          const charges = world.tiles.l1Charge;
          for (let i = pendingShocks.length - 1; i >= 0; i--) {
            const p = pendingShocks[i]!;
            if (p.tick <= world.serverTick) {
              pendingShocks.splice(i, 1);
              continue;
            }
            if (nowMs - p.firedAtMs > MAX_AGE_MS) {
              pendingShocks.splice(i, 1);
              continue;
            }
            if (p.idx < charges.length && (charges[p.idx] ?? 0) < SHOCK_LINGER_TICKS) {
              charges[p.idx] = SHOCK_LINGER_TICKS;
            }
          }
        }
        break;
      case MessageType.PlayerJoined:
        world.ensurePlayer(m.payload.player);
        break;
      case MessageType.PlayerLeft:
        world.removePlayer(m.payload.playerId);
        break;
      case MessageType.Error:
        console.warn('[server error]', m.payload);
        socket.close();
        if (codeBanner) codeBanner.remove();
        lobby.reset();
        lobby.showError(`server: ${m.payload.message}`);
        break;
      default:
        break;
    }
  });

  // If the socket dies before Welcome arrives we'd otherwise be stuck on a
  // blank page (lobby disabled, no game ever loads). Surface a clear error
  // and re-enable the form so the user can retry. This is the user-visible
  // signal for "version mismatch" or "server isn't running new code yet."
  socket.onClose(() => {
    if (welcomeReceived) return;
    if (codeBanner) codeBanner.remove();
    lobby.reset();
    lobby.showError(
      'connection closed before joining — server may be down or running a different version. try again in a moment',
    );
  });

  // Cycle the network simulator profile with P. Used during manual playtest.
  // Previously bound to KeyF; moved to KeyP because F is now the shock-fire
  // key (B1 electrical-defense). Cycling netsim is dev-only, so a less
  // prominent binding is fine.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP') {
      const next = socket.cycleNetSimProfile();
      console.info('[netsim] →', next);
    }
    if (e.code === 'KeyB') {
      // request another bot in this room
      window.dispatchEvent(new CustomEvent('gridforce:add-bot'));
    }
    // NPC stress-test keybinds. Server is host-gated, so a non-host
    // pressing these is a no-op — fine, dev-only affordance.
    if (e.code === 'KeyN') {
      socket.sendSetNpcCount(world.npcs.size + 20);
    }
    if (e.code === 'KeyJ') {
      socket.sendSetNpcCount(world.npcs.size + 100);
    }
    if (e.code === 'KeyK') {
      socket.sendSetNpcCount(0);
    }
    // Home → recenter the camera onto the local player and re-enable follow
    // after a free-pan (Task 20). The camera is only valid once Renderer.init
    // has run (post-Welcome); before that we just no-op.
    if (e.code === 'Home') {
      renderer.camera?.recenter();
    }
  });

  // Middle-mouse drag → free-pan the camera (Task 20). We track the previous
  // cursor position while the middle button is held and feed deltas to
  // camera.pan(). preventDefault on the mousedown so the browser's autoscroll
  // affordance doesn't appear under the canvas.
  let isDraggingPan = false;
  let panLastX = 0;
  let panLastY = 0;
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    isDraggingPan = true;
    panLastX = e.clientX;
    panLastY = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!isDraggingPan) return;
    const dx = e.clientX - panLastX;
    const dy = e.clientY - panLastY;
    panLastX = e.clientX;
    panLastY = e.clientY;
    renderer.camera?.pan(dx, dy);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 1) return;
    isDraggingPan = false;
  });
  window.addEventListener('gridforce:add-bot', () => {
    socket.sendRaw(AddBotMsg.encode({}));
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Tab just came back. Three things may have gone wrong while hidden:
      //   1. rAF kept firing at ~1 Hz with clamped dt, so predictedTick has
      //      crept hundreds of ticks ahead of the server.
      //   2. A ping that went out before backgrounding gets a delayed pong,
      //      which (without an outlier filter) would explode rttMs and the
      //      adaptive input lead.
      //   3. Remote interpolator's buffer is stuffed with old snapshots.
      // Reset all three to a clean baseline before the next frame fires.
      socket.resetRttForVisibilityRestore();
      world.forceResyncOnVisibilityRestore();
      world.remoteInterp.resetForVisibilityRestore();
      world.npcInterp.resetForVisibilityRestore();
      inputs.clear();
    }
  });

  function startLoop(): void {
    let last = performance.now();
    let accumulator = 0;
    let frameSamples = 0;
    let frameSampleStart = last;
    // Track the stage by id rather than index — a run swap in the lobby
    // keeps currentStageIndex at 0, so an index-only check would miss it.
    let lastRenderedStageId = '';
    // Local shock VFX edge tracking. C1.2: shock fires ONLY on the falling
    // edge (release); rising edge does nothing. Beam length scales with how
    // long the bit was held (mirrors server applyShockBeam). Cosmetic only —
    // if the server rejects the shock (non-conductive target), the local
    // beam still flashes briefly.
    let prevLocalShock = false;
    let shockDownAtMs = 0;
    // Tracks the earliest moment the next predicted shot may fire. The server
    // rejects shots while shockCooldownS > 0; without this gate, spam-clicks
    // would predict tiles that the server doesn't electrify — the tile would
    // briefly light client-side and then vanish on the next snapshot, which
    // reads as a glitchy "missing tile" instead of a clean rate-limit.
    let nextShockReadyAtMs = 0;
    // "resyncing…" banner is shown while rtt EWMA is unpopulated (=0). This
    // happens at startup before the first pong and again after visibility
    // restore (resetRttForVisibilityRestore zeros it). On bad-profile
    // connections the recovery window is 300+ ms and the input lead hasn't
    // adapted yet, so the user sees jank without context — the banner gives
    // them an explicit signal that the game is reconnecting, not broken.
    const resyncEl = document.getElementById('resync');

    const onFrame = () => {
      const now = performance.now();
      let dt = (now - last) / 1000;
      if (dt > CLIENT_MAX_FRAME_DT_S) dt = CLIENT_MAX_FRAME_DT_S;
      last = now;

      accumulator += dt * 1000;
      while (accumulator >= SERVER_TICK_DT_MS) {
        // In lobby phase, ignore the keyboard so the player doesn't visibly
        // try to walk while the server's holding them at spawn — the
        // resulting reconciliation tug-of-war would look like input lag.
        // We still tick the predictor (with idle input) so input lead
        // bookkeeping advances and a clean transition into 'playing' has
        // accurate predictedTick.
        //
        // Feed the local player's predicted world position into sample() so
        // facingRad is cursor-relative (atan2(cursor - localPlayer)). Before
        // the first snapshot lands, the local player may not exist yet — fall
        // back to origin, which produces a meaningless-but-safe facing value
        // and means no shock can fire in that window anyway (no localPlayer).
        const localForFacing = world.players.get(world.localPlayerId);
        const localPos = localForFacing
          ? { x: localForFacing.x, y: localForFacing.y }
          : { x: 0, y: 0 };
        const raw = inputs.sample(localPos);
        const sample = world.phase === 'lobby'
          ? {
              mx: 0,
              my: 0,
              shock: false,
              repair: false,
              jumpHeld: false,
              jumpCursorDx: 0,
              jumpCursorDy: 0,
              facingRad: raw.facingRad,
            }
          : {
              mx: raw.mx,
              my: raw.my,
              shock: raw.shock,
              repair: raw.repair,
              jumpHeld: raw.jumpHeld,
              jumpCursorDx: raw.jumpCursorDx,
              jumpCursorDy: raw.jumpCursorDy,
              facingRad: raw.facingRad,
            };
        const inp = world.step({ ...sample, clientTimeMs: now });
        socket.sendInput(inp);

        // Shock VFX (local player only) — fires on the falling edge of the
        // bit, mirroring the server's applyShockBeam. Beam length scales
        // with how long the bit was held (1..SHOCK_BEAM_MAX_TILES). Angle
        // is the actual cursor facingRad (no cardinal snap).
        if (world.phase !== 'lobby' && localForFacing) {
          if (sample.shock && !prevLocalShock) {
            shockDownAtMs = now;
          } else if (!sample.shock && prevLocalShock && now >= nextShockReadyAtMs) {
            const heldS = (now - shockDownAtMs) / 1000;
            const ratio = Math.min(1, heldS / SHOCK_CHARGE_FULL_S);
            const isCharged = ratio >= 0.5;
            const localPost = world.players.get(world.localPlayerId) ?? localForFacing;
            // Predict tile electrification client-side so the panel lights up
            // immediately instead of waiting for the next server snapshot
            // (~50-250ms of snapshot-batch + RTT). traceShockBeam is the same
            // helper the server's applyShockBeam uses, so the predicted hits
            // match the authoritative set tile-for-tile. When the snapshot
            // lands it overwrites `world.tiles` wholesale — the server's
            // l1Charge values converge with what we predicted (minus the
            // ticks of decay between fire and snapshot), so the transition
            // is seamless on the happy path.
            const traceState = { ...localPost, shockHeldS: heldS };
            const trace = traceShockBeam(
              traceState,
              { ...inp, facingRad: sample.facingRad },
              world.tiles,
              world.grid,
            );
            // Drive the VFX line length from the actual trace so the beam
            // visually stops where it stops gameplay-wise (at the last hit,
            // or one tile worth of reach when the trace returned no hits).
            const rangeTiles = Math.max(1, trace.hits.length);
            renderer.shockFx.fire(
              localPost.x,
              localPost.y,
              sample.facingRad,
              rangeTiles,
              isCharged,
            );
            for (const h of trace.hits) {
              if (h.conductive) {
                world.tiles.l1Charge[h.idx] = SHOCK_LINGER_TICKS;
                // Pin against snapshot clobber until the server acknowledges
                // this shot. world.predictedTick is the tick our outgoing
                // input is tagged with; snapshots with snap.tick < this tick
                // were authored before the server processed it.
                pendingShocks.push({
                  idx: h.idx,
                  tick: world.predictedTick,
                  firedAtMs: now,
                });
              }
            }
            // Mirror the server's cooldown so the next prediction can't fire
            // until the server would have accepted it. Without this we'd
            // predict ghost tiles that vanish on the next snapshot.
            const cooldownS = isCharged ? SHOCK_CHARGE_COOLDOWN_S : SHOCK_COOLDOWN_S;
            nextShockReadyAtMs = now + cooldownS * 1000;
          }
          prevLocalShock = sample.shock;
        } else {
          prevLocalShock = false;
        }

        accumulator -= SERVER_TICK_DT_MS;
      }

      const alpha = Math.max(0, Math.min(1, accumulator / SERVER_TICK_DT_MS));
      world.decayCorrection(dt * 1000);

      // Adaptive input lead: scales with measured RTT so high-latency
      // connections don't have their inputs land in the server's past.
      // The +2 jitter margin covers ~one tick (~33 ms) of one-way
      // variance, which is more than enough for any non-pathological
      // connection. Previously this was +6 (~200 ms) to absorb the "bad"
      // netsim profile's ±60 ms jitter — that headroom turned a sub-100ms
      // RTT player's perceived action latency into ~250 ms because every
      // shock/jump waited 7 ticks before the server processed it.
      // High-jitter players are still covered by the redundancy window
      // (3 packed inputs per message) and the adaptive lead growing
      // when oneWayTicks itself rises.
      const rtt = socket.status().rttMs;
      if (rtt > 0) {
        const oneWayTicks = Math.ceil(rtt / 2 / SERVER_TICK_DT_MS);
        world.setTargetLead(oneWayTicks + 1);
      }

      // Render NPCs first so a dense swarm doesn't cover the player avatars.
      renderer.npcRenderer.beginFrame();
      world.forEachNpcRender(now, (id, x, y, facing) => {
        renderer.npcRenderer.draw(id, x, y, facing);
      });
      renderer.npcRenderer.endFrame();

      // Crawlers (electrical-defense B1): drawn above npcs z-order is handled
      // by Renderer.init — here we just push positions each frame. Passing
      // `now` lets the renderer animate the ATTACKING pulse phase smoothly.
      renderer.crawlerRenderer.beginFrame(now);
      for (const c of world.crawlers.values()) {
        renderer.crawlerRenderer.draw(c.id, c.x, c.y, c.facing, c.ai);
      }
      renderer.crawlerRenderer.endFrame();

      // Carbon pickups: drawn below crawlers (z-order set in Renderer.init).
      renderer.carbonRenderer.beginFrame();
      for (const carbon of world.carbons.values()) {
        renderer.carbonRenderer.draw(carbon.id, carbon.x, carbon.y, carbon.ttlS);
      }
      renderer.carbonRenderer.endFrame();

      // React to stage transitions (including the very first frame, and
      // lobby-time run swaps that don't move the stage index).
      const currentStage = world.getCurrentStage();
      if (currentStage.id !== lastRenderedStageId) {
        renderer.setGrid(currentStage.grid);
        lastRenderedStageId = currentStage.id;
      }

      // Push latest layered tile state to the grid renderer each frame.
      // Reference-equality check inside setTiles avoids redundant redraws —
      // PredictedWorld swaps the TileBuffers object on snapshot apply, so
      // most frames are a cheap pointer compare.
      if (world.tiles.l1Hp.length > 0) {
        renderer.gridRenderer.setTiles(world.tiles);
      }

      // Render players: local from prediction, remotes from interpolator.
      const me = world.visualLocalPosition(alpha);
      const ids: PlayerId[] = [];
      for (const id of world.players.keys()) ids.push(id);
      renderer.playerRenderer.update(ids, (id) => {
        if (id === world.localPlayerId) {
          return { x: me.x, y: me.y, facing: me.facing };
        }
        const sample = world.remoteInterp.sample(id, now);
        if (!sample) return null;
        return sample;
      });

      // Jump-target overlay (Task 22): visible while Shift is held; highlights
      // the destination tile = localPlayer tile + cursor (dx, dy). Local player
      // tile floor() handles the half-open boundary correctly for both axes.
      const jumpHeld = inputs.isJumpHeld();
      renderer.jumpTargetOverlay.setVisible(jumpHeld);
      if (jumpHeld) {
        const pcx = Math.floor(me.x / PANEL_SIZE);
        const pcy = Math.floor(me.y / PANEL_SIZE);
        renderer.jumpTargetOverlay.setTargetTile(
          pcx,
          pcy,
          inputs.getJumpCursorDx(),
          inputs.getJumpCursorDy(),
        );
      }

      // Shock VFX decay/clear (purely visual; runs every frame regardless of
      // tick accumulator so flashes fade smoothly at vsync rate).
      renderer.shockFx.update(dt * 1000);

      // Camera follows the local player.
      renderer.tick(dt * 1000, me.x, me.y);

      // Minimap (Task 23): rendered in screen space, after the camera tick
      // so getCameraViewRect() reflects this frame's center/zoom. Built
      // from the client-mirrored state — no extra wire payload.
      if (world.tiles.l1Hp.length > 0) {
        const camRect = renderer.getCameraViewRect();
        renderer.minimap.render(
          world.tiles,
          Array.from(world.players.values()),
          Array.from(world.crawlers.values()),
          camRect,
          dt,
        );
      }

      // Edge-pan (Task 21): hardcoded off via CAMERA_EDGE_PAN_DEFAULT. A
      // future settings spec will let the user toggle this. Setting every
      // frame is wasteful but harmless; we'd rather have a single source of
      // truth than risk a stale value after a hypothetical hot-reload.
      if (renderer.camera) {
        renderer.camera.setEdgePanEnabled(CAMERA_EDGE_PAN_DEFAULT);
        renderer.camera.updateEdgePan(
          { x: inputs.getMouseScreenX(), y: inputs.getMouseScreenY() },
          dt,
        );
      }

      // Resync banner. Show whenever rtt is unpopulated, hide the moment
      // a valid pong repopulates it — instant on/off, no fade, no hold.
      const status = socket.status();
      const resyncing = status.state === 'open' && status.rttMs === 0;
      if (resyncEl) resyncEl.classList.toggle('visible', resyncing);

      // Pre-game lobby panel. Updates only when its signature changes, so
      // calling every frame is cheap.
      lobbyOverlay.update({
        phase: world.phase,
        hostId: world.hostId,
        localPlayerId: world.localPlayerId,
        roomCode,
        runId: world.runId,
        difficulty: world.difficulty,
        maxPlayers: world.maxPlayers,
        players: Array.from(world.players.values()),
      });
      stageHud?.update({
        phase: world.phase,
        stage: world.getCurrentStage(),
        phaseDef: world.getCurrentPhase(),
        stageIndex: world.currentStageIndex,
        totalStages: world.getRun().stageSequence.length,
        phaseElapsedS: world.phaseElapsedS,
      });
      const mePlayer = world.players.get(world.localPlayerId);
      if (mePlayer) {
        gameHud?.update({
          carbon: mePlayer.carbon,
          repairProgressS: mePlayer.repairProgressS,
        });
      }

      // FPS sample
      frameSamples++;
      if (now - frameSampleStart >= 500) {
        const fps = (frameSamples * 1000) / (now - frameSampleStart);
        if (hud) {
          hud.update({
            fps,
            socket: socket.status(),
            prediction: world.diagnostics,
            remoteDelayMs: world.remoteInterp.currentDelayMs,
            netSimName: socket.status().lastSimProfileName,
            npcCount: world.npcs.size,
            isHost: world.localPlayerId !== 0 && world.hostId === world.localPlayerId,
          });
        }
        frameSamples = 0;
        frameSampleStart = now;
      }

      requestAnimationFrame(onFrame);
    };

    requestAnimationFrame(onFrame);
  }

  // Cleanup on unload — let the server see a clean disconnect.
  window.addEventListener('beforeunload', () => {
    off();
    socket.close();
    inputs.dispose();
    renderer.destroy();
    lobbyOverlay.destroy();
  });

  // Set initial netsim profile to "off" so HUD has something to display.
  socket.setNetSimProfile('off', NETSIM_PROFILES.off!);
}
