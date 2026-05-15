import {
  AddBotMsg,
  CLIENT_MAX_FRAME_DT_S,
  MessageType,
  NETSIM_PROFILES,
  SERVER_TICK_DT_MS,
  type PlayerId,
  type PlayerState,
} from '@gridforce/shared';

import { createInvite, redeemInvite, LobbyApiError } from './api.js';
import { InputCapture } from './input/InputCapture.js';
import { Socket } from './net/Socket.js';
import { Renderer } from './render/Renderer.js';
import { PredictedWorld } from './sim/PredictedWorld.js';
import { DebugHud } from './ui/DebugHud.js';
import { Lobby } from './ui/Lobby.js';
import { LobbyOverlay } from './ui/LobbyOverlay.js';
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
  let hud: DebugHud | null = null;
  let stageHud: StageHud | null = null;
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
            hud = new DebugHud();
            stageHud = new StageHud();
            codeBanner = lobby.showRoomCode(roomCode || 'NEW');
            startLoop();
          })
          .catch((err) => console.error('[render] init:', err));
        break;
      case MessageType.Snapshot:
        world.applySnapshot(m.payload);
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

  // Cycle the network simulator profile with F. Used during manual playtest.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') {
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
        const raw = inputs.sample();
        const sample = world.phase === 'lobby' ? { mx: 0, my: 0, dash: false, sprint: false } : raw;
        const inp = world.step({ ...sample, clientTimeMs: now });
        socket.sendInput(inp);
        accumulator -= SERVER_TICK_DT_MS;
      }

      const alpha = Math.max(0, Math.min(1, accumulator / SERVER_TICK_DT_MS));
      world.decayCorrection(dt * 1000);

      // Adaptive input lead: scales with measured RTT so high-latency
      // connections don't have their inputs land in the server's past.
      // The +6 safety margin covers per-direction jitter up to ~200 ms,
      // enough headroom for the "bad" profile's ±60 ms one-way jitter
      // even when EWMA lags individual high samples. Without enough
      // jitter headroom, individual late packets cause the server to
      // idle for that tick, producing ~7 px/tick divergence that the
      // smooth-correction system can't fully decay between snapshots.
      const rtt = socket.status().rttMs;
      if (rtt > 0) {
        const oneWayTicks = Math.ceil(rtt / 2 / SERVER_TICK_DT_MS);
        world.setTargetLead(oneWayTicks + 6);
      }

      // Render NPCs first so a dense swarm doesn't cover the player avatars.
      renderer.npcRenderer.beginFrame();
      world.forEachNpcRender(now, (id, x, y, facing) => {
        renderer.npcRenderer.draw(id, x, y, facing);
      });
      renderer.npcRenderer.endFrame();

      // Render players: local from prediction, remotes from interpolator.
      const ids: PlayerId[] = [];
      for (const id of world.players.keys()) ids.push(id);
      renderer.playerRenderer.update(ids, (id) => {
        if (id === world.localPlayerId) {
          const v = world.visualLocalPosition(alpha);
          const cur: PlayerState | undefined = world.players.get(id);
          return { x: v.x, y: v.y, facing: v.facing, dashing: !!cur && cur.dashRemainingS > 0 };
        }
        const sample = world.remoteInterp.sample(id, now);
        if (!sample) return null;
        const cur = world.players.get(id);
        return { ...sample, dashing: !!cur && cur.dashRemainingS > 0 };
      });

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
