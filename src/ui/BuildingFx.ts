/**
 * 建筑头顶的动态 SVG —— 开采 / 开火 / 接敌三种状态图标，CSS @keyframes 驱动。
 *
 * 与 BuildingBars 同一层规矩：refresh 10Hz 增删节点，placeAll 每帧搬位置。
 * 状态判据用 Readouts.readoutOf，不另算一遍。
 */

import type { Combat } from '@game/systems/Combat';
import { readoutOf } from '@game/systems/Readouts';
import type { Building, GameWorld } from '@game/world/GameWorld';
import { make, type HudWidget } from './dom';

/** 挂在血条上方，别压住 */
const LIFT = 30;

export function fxLift(x: number, y: number): string {
  return `translate3d(${Math.round(x)}px, ${Math.round(y - LIFT)}px, 0) translate(-50%, -50%)`;
}

type FxKind = 'mine' | 'fire' | 'clash' | 'repair';

interface FxNode {
  el: HTMLElement;
  kind: FxKind;
}

const SVG: Record<FxKind, string> = {
  mine: `<svg viewBox="0 0 16 16" class="bfx-svg bfx-svg--mine">
    <rect x="1" y="11" width="7" height="4" rx="1" fill="#8e93a3"/>
    <rect x="2" y="9" width="2" height="2" fill="#5f6472"/>
    <rect x="5" y="10" width="2" height="1" fill="#5f6472"/>
    <g class="bfx-mine__pick">
      <rect x="7" y="3" width="7" height="1.4" fill="#9a6b3f"/>
      <rect x="13" y="2" width="2.4" height="3" rx="0.5" fill="#5f6472"/>
    </g>
  </svg>`,
  fire: `<svg viewBox="0 0 16 16" class="bfx-svg bfx-svg--fire">
    <polygon class="bfx-fire__flash" points="8,1 9.5,5.5 14,5.5 10.5,8.5 12.5,13 8,10.5 3.5,13 5.5,8.5 2,5.5 6.5,5.5" fill="#f6dc9c"/>
    <circle class="bfx-fire__spark" cx="8" cy="8" r="2" fill="#e8584c"/>
  </svg>`,
  // 锤子：铁头 + 木柄，整把绕柄尾抡（CSS 里用 steps() 阶梯，别平滑）
  repair: `<svg viewBox="0 0 16 16" class="bfx-svg bfx-svg--repair" shape-rendering="crispEdges">
    <g class="bfx-repair__hammer">
      <rect x="3" y="2" width="10" height="3" fill="#b8c1cf"/>
      <rect x="3" y="5" width="10" height="2" fill="#6b7280"/>
      <rect x="7" y="7" width="2" height="6" fill="#a9762c"/>
      <rect x="9" y="7" width="1" height="6" fill="#6b4526"/>
    </g>
    <rect class="bfx-repair__spark" x="12" y="1" width="2" height="2" fill="#ffd36b"/>
  </svg>`,
  clash: `<svg viewBox="0 0 16 16" class="bfx-svg bfx-svg--clash">
    <g class="bfx-clash__l">
      <rect x="2" y="7" width="9" height="1.4" rx="0.5" fill="#d9b25c"/>
      <rect x="2" y="6" width="2" height="3.4" rx="0.5" fill="#6b4526"/>
    </g>
    <g class="bfx-clash__r">
      <rect x="5" y="7" width="9" height="1.4" rx="0.5" fill="#d9b25c"/>
      <rect x="12" y="6" width="2" height="3.4" rx="0.5" fill="#6b4526"/>
    </g>
  </svg>`,
};

export class BuildingFx implements HudWidget {
  readonly el = make('div', { class: 'bfx' });
  private readonly nodes = new Map<number, FxNode>();

  constructor(
    private readonly world: GameWorld,
    private readonly combat: Combat,
  ) {}

  refresh(): void {
    const live = new Set<number>();
    for (const b of this.world.buildings.values()) {
      if (!b.built) continue;
      const kind = this.kindOf(b);
      if (!kind) continue;
      live.add(b.id);
      this.ensure(b.id, kind);
    }
    for (const [id, node] of this.nodes) {
      if (live.has(id)) continue;
      node.el.remove();
      this.nodes.delete(id);
    }
  }

  private kindOf(b: Building): FxKind | null {
    // 修理优先：真在回血的那一栋，头顶就该是锤子，而不是它平时的"开采 / 开火"图标
    if (this.combat.isRepairing(b.id)) return 'repair';
    const r = readoutOf(this.world, this.combat, b);
    if (b.def.veinWork) return 'mine';
    if (r.ammo && (r.ammo.reloading > 0 || r.ammo.left < r.ammo.size)) return 'fire';
    if (r.squad && r.squad.alive > 0) return 'clash';
    return null;
  }

  private ensure(id: number, kind: FxKind): void {
    const hit = this.nodes.get(id);
    if (hit && hit.kind === kind) return;
    if (hit) hit.el.remove();
    const el = make('div', { class: `bfx__icon bfx__icon--${kind}` });
    el.innerHTML = SVG[kind];
    this.el.append(el);
    this.nodes.set(id, { el, kind });
  }

  placeAll(locate: (id: number) => { x: number; y: number; inFront: boolean }): void {
    for (const [id, node] of this.nodes) {
      const p = locate(id);
      node.el.hidden = !p.inFront;
      node.el.style.transform = fxLift(p.x, p.y);
    }
  }

  forget(id: number): void {
    this.nodes.get(id)?.el.remove();
    this.nodes.delete(id);
  }

  get count(): number {
    return this.nodes.size;
  }
}
