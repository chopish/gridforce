import { Container, Graphics } from 'pixi.js';

// Tiny hostile-looking dots. Phase 0 NPCs are pure netcode stress test
// fixtures, so we don't try to dress them up — a small filled circle is
// enough to see motion and density. PlayerRenderer-style facing arrows
// would just be visual noise at 300+ entities.

const NPC_COLOR = 0xff6e6e;
const NPC_RADIUS = 5;

interface Sprite {
  body: Graphics;
}

export class NpcRenderer {
  root = new Container();
  private sprites = new Map<number, Sprite>();
  // Reused across frames so the .update path stays allocation-free for
  // the steady-state case where the set of ids hasn't changed.
  private seen = new Set<number>();

  // Drive sprite creation/removal by passing in the current set of ids
  // (one call per frame). The caller writes positions via setPosition.
  beginFrame(): void {
    this.seen.clear();
  }

  draw(id: number, x: number, y: number, _facing: number): void {
    this.seen.add(id);
    let s = this.sprites.get(id);
    if (!s) {
      const body = new Graphics();
      body
        .circle(0, 0, NPC_RADIUS)
        .fill({ color: NPC_COLOR })
        .stroke({ width: 1, color: 0x0a0a0f });
      this.sprites.set(id, { body });
      this.root.addChild(body);
      s = this.sprites.get(id)!;
    }
    s.body.x = x;
    s.body.y = y;
  }

  endFrame(): void {
    for (const [id, s] of this.sprites) {
      if (!this.seen.has(id)) {
        this.root.removeChild(s.body);
        s.body.destroy();
        this.sprites.delete(id);
      }
    }
  }

  get count(): number {
    return this.sprites.size;
  }
}
