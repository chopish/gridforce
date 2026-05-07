import {
  SNAPSHOT_INTERPOLATION_DELAY_MS,
  TICK_DT_S,
  type ServerWelcome,
} from '@gridforce/shared';
import { showLobby } from './ui/Lobby.js';
import { GameSocket } from './net/Socket.js';
import { InputCapture } from './input/InputCapture.js';
import { Renderer } from './render/Renderer.js';
import { GridRenderer } from './render/GridRenderer.js';
import { PlayerRenderer } from './render/PlayerRenderer.js';
import { PredictedWorld, RemotePlayerInterpolator } from './sim/PredictedWorld.js';
import { DebugHud } from './ui/DebugHud.js';

async function main() {
  const lobby = await showLobby();
  const socket = new GameSocket(lobby.roomCode, lobby.name);
  await socket.ready();

  const welcome = await new Promise<ServerWelcome>((resolve, reject) => {
    const off = socket.onMessage((msg) => {
      if (msg.type === 'welcome') {
        off();
        resolve(msg);
      } else if (msg.type === 'error') {
        off();
        reject(new Error(`${msg.code}: ${msg.message}`));
      }
    });
    socket.onClose(() => reject(new Error('Connection closed before welcome')));
  });

  await runGame(socket, welcome);
}

async function runGame(socket: GameSocket, welcome: ServerWelcome): Promise<void> {
  const host = document.getElementById('app')!;

  const renderer = new Renderer();
  await renderer.init(host, welcome.grid);

  const gridRenderer = new GridRenderer();
  const playerRenderer = new PlayerRenderer(welcome.playerId);
  renderer.worldRoot.addChild(gridRenderer.view);
  renderer.worldRoot.addChild(playerRenderer.view);
  gridRenderer.render(welcome.grid);

  const input = new InputCapture();
  const detachInput = input.attach(window);

  const predicted = new PredictedWorld(welcome.playerId, welcome.grid, welcome.snapshot);
  const interpolator = new RemotePlayerInterpolator(SNAPSHOT_INTERPOLATION_DELAY_MS);
  interpolator.push(welcome.snapshot);

  const hud = new DebugHud();
  hud.show();

  socket.onMessage((msg) => {
    if (msg.type === 'snapshot') {
      predicted.applySnapshot(msg);
      interpolator.push(msg);
    }
  });

  // Add bot button (Backtick key) — quality-of-life for testing
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') socket.addBot();
  });

  let accumulator = 0;
  let lastFrame = performance.now();
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.25) dt = 0.25; // clamp huge dt (tab away)

    accumulator += dt;
    while (accumulator >= TICK_DT_S) {
      accumulator -= TICK_DT_S;
      // Sample input is keyed by the *next* tick we're about to advance to
      const localInput = input.sample(predicted.currentTick + 1);
      const sentInput = predicted.step({
        mx: localInput.mx,
        my: localInput.my,
        dash: localInput.dash,
      });
      socket.sendInput(sentInput);
    }

    // Render
    const localPlayer = predicted.getLocalPlayer();
    const remotes = interpolator.interpolate(welcome.playerId);
    playerRenderer.render(localPlayer, remotes);

    hud.tick();
    hud.update({
      tick: predicted.currentTick,
      rttMs: socket.rttMs,
      predictionErrorPx: predicted.lastPredictionErrorPx,
      reconcileRewindTicks: predicted.lastReconcileRewindTicks,
      pendingInputs: predicted.pendingInputCount(),
    });

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  socket.onClose(() => {
    stopped = true;
    detachInput();
    renderer.destroy();
    hud.hide();
    showDisconnected();
  });
}

function showDisconnected(): void {
  const div = document.createElement('div');
  div.className = 'lobby';
  div.innerHTML = `
    <h1 style="color:#ff6e6e">DISCONNECTED</h1>
    <button onclick="window.location.reload()">Reload</button>
  `;
  document.body.appendChild(div);
}

main().catch((err) => {
  console.error(err);
  const div = document.createElement('div');
  div.className = 'lobby';
  div.innerHTML = `
    <h1 style="color:#ff6e6e">ERROR</h1>
    <div>${(err as Error).message}</div>
    <button onclick="window.location.reload()">Reload</button>
  `;
  document.body.appendChild(div);
});
