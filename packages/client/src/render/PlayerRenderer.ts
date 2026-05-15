import { Container, Graphics } from 'pixi.js';

import { PLAYER_RADIUS, type PlayerId, type PlayerState } from '@gridforce/shared';

const PLAYER_COLORS = [0x6ee7ff, 0xff6e9c, 0xffcc6e, 0x9cff6e];
const LOCAL_RING_COLOR = 0xffffff;

interface PlayerSprite {
  bodyRoot: Container; // rotates with facing
  body: Graphics;
  arrow: Graphics;
  ring: Graphics; // local-player highlight
}

// Renders one circle + facing arrow per player. Sprite rotation is on a
// dedicated `bodyRoot` so labels (or future name tags) can stay upright while
// the body rotates with the facing angle.
export class PlayerRenderer {
  root = new Container();
  private sprites = new Map<PlayerId, PlayerSprite>();
  private localPlayerId: PlayerId = -1;

  setLocalPlayer(id: PlayerId): void {
    this.localPlayerId = id;
    // Re-style existing sprites if local id changed.
    for (const [pid, s] of this.sprites) this.styleRing(pid, s);
  }

  // Update all sprites in one pass. `getRender(id)` returns the visual
  // position+facing that should be drawn for the player. Returning null means
  // "remove this sprite" (player has left).
  update(
    ids: Iterable<PlayerId>,
    getRender: (id: PlayerId) => { x: number; y: number; facing: number } | null,
  ): void {
    const seen = new Set<PlayerId>();
    for (const id of ids) {
      const r = getRender(id);
      if (!r) continue;
      seen.add(id);
      let s = this.sprites.get(id);
      if (!s) {
        s = this.createSprite(id);
        this.sprites.set(id, s);
        this.root.addChild(s.bodyRoot);
      }
      s.bodyRoot.x = r.x;
      s.bodyRoot.y = r.y;
      s.bodyRoot.rotation = r.facing;
    }
    // Remove sprites for players no longer present.
    for (const [id, s] of this.sprites) {
      if (!seen.has(id)) {
        this.root.removeChild(s.bodyRoot);
        s.bodyRoot.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
  }

  private createSprite(id: PlayerId): PlayerSprite {
    const colorIdx = id % PLAYER_COLORS.length;
    const color = PLAYER_COLORS[colorIdx]!;

    const bodyRoot = new Container();
    const body = new Graphics();
    body.circle(0, 0, PLAYER_RADIUS).fill({ color }).stroke({ width: 2, color: 0x0a0a0f });
    bodyRoot.addChild(body);

    const arrow = new Graphics();
    arrow
      .moveTo(PLAYER_RADIUS + 2, 0)
      .lineTo(PLAYER_RADIUS - 4, -4)
      .lineTo(PLAYER_RADIUS - 4, 4)
      .closePath()
      .fill({ color: 0xffffff });
    bodyRoot.addChild(arrow);

    const ring = new Graphics();
    bodyRoot.addChild(ring);

    const sprite: PlayerSprite = { bodyRoot, body, arrow, ring };
    this.styleRing(id, sprite);
    return sprite;
  }

  private styleRing(id: PlayerId, s: PlayerSprite): void {
    s.ring.clear();
    if (id === this.localPlayerId) {
      s.ring
        .circle(0, 0, PLAYER_RADIUS + 4)
        .stroke({ width: 1.5, color: LOCAL_RING_COLOR, alpha: 0.7 });
    }
  }

  hasSprite(id: PlayerId): boolean {
    return this.sprites.has(id);
  }

  // For Phase 0 only: write into a sprite without using the bulk update path.
  // Used by debug visualisations.
  syncDirectly(state: PlayerState): void {
    let s = this.sprites.get(state.id);
    if (!s) {
      s = this.createSprite(state.id);
      this.sprites.set(state.id, s);
      this.root.addChild(s.bodyRoot);
    }
    s.bodyRoot.x = state.x;
    s.bodyRoot.y = state.y;
    s.bodyRoot.rotation = state.facing;
  }
}
