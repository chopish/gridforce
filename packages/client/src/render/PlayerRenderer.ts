import { Container, Graphics, Text } from 'pixi.js';
import { PLAYER_RADIUS, type Player } from '@gridforce/shared';

interface PlayerVisual {
  // Root translates with the player; does NOT rotate.
  container: Container;
  // Inner sub-container that DOES rotate to face movement direction.
  bodyRoot: Container;
  body: Graphics;
  label: Text;
}

const COLORS = [0x6ee7ff, 0xff7adb, 0x9dffa0, 0xffd66e];
const BOT_COLOR = 0x808a99;

export class PlayerRenderer {
  readonly view: Container;
  private visuals = new Map<string, PlayerVisual>();
  private localPlayerId: string;

  constructor(localPlayerId: string) {
    this.view = new Container();
    this.localPlayerId = localPlayerId;
  }

  render(localPlayer: Player | undefined, remotePlayers: Player[]): void {
    const seen = new Set<string>();
    const all: Player[] = [];
    if (localPlayer) all.push(localPlayer);
    all.push(...remotePlayers);

    for (let i = 0; i < all.length; i++) {
      const p = all[i]!;
      seen.add(p.id);
      const v = this.getOrCreate(p, i);
      v.container.x = p.x;
      v.container.y = p.y;
      v.bodyRoot.rotation = p.facing;

      // Tint dimmer if dashing for a quick visual cue
      if (p.dashTimer > 0) {
        v.body.alpha = 0.7;
      } else {
        v.body.alpha = 1;
      }
    }

    // Remove visuals for players who left
    for (const id of [...this.visuals.keys()]) {
      if (!seen.has(id)) {
        const v = this.visuals.get(id)!;
        this.view.removeChild(v.container);
        v.container.destroy({ children: true });
        this.visuals.delete(id);
      }
    }
  }

  private getOrCreate(p: Player, index: number): PlayerVisual {
    let v = this.visuals.get(p.id);
    if (v) return v;

    const container = new Container();
    const bodyRoot = new Container();
    const body = new Graphics();
    const color = p.isBot ? BOT_COLOR : COLORS[index % COLORS.length]!;
    const isLocal = p.id === this.localPlayerId;

    // Body: a slightly elongated arrow circle to convey facing
    body
      .circle(0, 0, PLAYER_RADIUS)
      .fill({ color })
      .stroke({ color: 0x000000, width: 2, alignment: 1 });

    // Direction indicator (a small notch toward facing)
    body
      .moveTo(PLAYER_RADIUS - 2, 0)
      .lineTo(PLAYER_RADIUS + 6, 0)
      .stroke({ color: 0x000000, width: 3 });

    // Local player gets a subtle ring
    if (isLocal) {
      body
        .circle(0, 0, PLAYER_RADIUS + 4)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
    }

    bodyRoot.addChild(body);
    container.addChild(bodyRoot);

    const label = new Text({
      text: p.name,
      style: {
        fontFamily: 'monospace',
        fontSize: 10,
        fill: 0xcfd6e0,
        align: 'center',
      },
    });
    label.anchor.set(0.5, 1);
    label.x = 0;
    label.y = -PLAYER_RADIUS - 4;
    container.addChild(label);

    this.view.addChild(container);
    v = { container, bodyRoot, body, label };
    this.visuals.set(p.id, v);
    return v;
  }
}
