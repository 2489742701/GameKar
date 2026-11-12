/**
 * **世界空间的自动修复动画**（2026-11-08 P-081 改口径）。
 *
 * 原本是"脱战后冒一颗小锤子按钮，点一下才修"；用户后来改成
 * "**不需要点按钮，就是自动修复**"，所以按钮整个删掉 ——
 * 这一层现在只干一件事：把 `world.isRepairing()` 为真的楼顶上挂一枚
 * 小号 SVG（锤子敲板子），告诉玩家"这栋正在自己回血"。
 *
 * 规矩：
 * 1. **判据全在逻辑层**：显隐只读 `world.isRepairing()`，这里不设 `setTimeout`、
 *    不记"脱战多久"。挨打时 `hurtBuilding` 把 `repairLeft` 清零，动画这一帧就停。
 * 2. **每帧跟随相机**：DOM 徽标，锚点是 3D 世界坐标，draw() 里投影一次。
 * 3. **双方都显示**：自动修复是规则不是点击，AI/托管同样受它约束；
 *    动画只是状态镜，不区分阵营。
 * 4. 尺寸按用户要求收小了一档，别挡住战场。
 */
import { el as make } from '@ui/dom';
import type { ArenaBuilding } from '../types';

/**
 * P-096 用户："建筑维修的 SVG 不需要边框，就是一个动态图标就行了……
 * 我看到你是用了一个锤子，但是动画是扳手的，能不能改成锤子敲打的动画"。
 *
 * 改法三处：
 * 1. **去掉徽章底板**（CSS 里的 border / background / box-shadow）与「修复中」文字，
 *    整个层只剩这一枚会动的 SVG；
 * 2. SVG 自身不再给板子/锤子描边（旧版一圈 stroke 把图标读成"一块带框的小牌子"）；
 * 3. 锤子重画成**柄在上、锤头在下压着木板**，动画从"举起 → 加速砸下 → 微弹 → 抬回"，
 *    不再绕柄尾左右摆（那个动作看起来像扳手拧螺母）。
 * 节奏仍在 arena.css 的 0.56s；关键帧名 `rp-swing` 沿用旧锁，内容已换成敲打。
 */
const REPAIR_SVG = /* html */ `
  <svg class="rp__svg" viewBox="0 0 56 44" width="40" height="32" aria-hidden="true">
    <rect x="2" y="29" width="52" height="11" rx="2.5" fill="#a4703f"/>
    <path d="M6 33 h44 M6 37 h44" fill="none" stroke="#7c512b" stroke-width="0.8" opacity=".65"/>
    <circle cx="10" cy="34.5" r="1.2" fill="#3d4249"/>
    <circle cx="46" cy="34.5" r="1.2" fill="#3d4249"/>
    <g class="rp__spark" fill="none" stroke="#ffd884" stroke-width="1.9" stroke-linecap="round">
      <path d="M19 26 l-4 -4 M25 24 l0 -6 M31 26 l4 -4"/>
    </g>
    <g class="rp__hammer">
      <rect x="27" y="6" width="4.4" height="22" rx="2" fill="#8b5a2f"/>
      <rect x="18" y="24" width="22" height="8" rx="2" fill="#c9d2dc"/>
      <rect x="18" y="24" width="5" height="8" rx="1.5" fill="#eaf0f6"/>
    </g>
  </svg>`;

/** App 暴露给这一层的最小接口（避免视图类去翻 three / 私有字段）。 */
export interface RepairViewHost {
  readonly world: {
    readonly buildings: Map<number, ArenaBuilding>;
    isRepairing(id: number): boolean;
  };
  /** 建筑头顶的世界坐标锚点；楼还没建好 / 已拆返回 null */
  repairAnchorOf(id: number): { x: number; y: number; z: number } | null;
  /** 世界坐标 → 相对 UI 容器的 CSS 像素坐标 */
  projectToScreen(p: { x: number; y: number; z: number }): { x: number; y: number; visible: boolean };
}

export class RepairButtons {
  readonly el: HTMLElement;
  private readonly nodes = new Map<number, HTMLElement>();

  constructor(host: HTMLElement, private readonly app: RepairViewHost) {
    this.el = make('div', 'rp-layer');
    host.append(this.el);
  }

  /** draw() 每帧调一次：只在 `isRepairing()` 为真时出现，投影 + 增删节点。 */
  update(): void {
    const alive = new Set<number>();
    for (const b of this.app.world.buildings.values()) {
      if (!this.app.world.isRepairing(b.id)) continue;

      const anchor = this.app.repairAnchorOf(b.id);
      if (!anchor) continue;
      const p = this.app.projectToScreen(anchor);
      const node = this.ensure(b.id);
      alive.add(b.id);

      node.style.display = p.visible ? '' : 'none';
      if (!p.visible) continue;
      node.style.left = `${p.x.toFixed(1)}px`;
      node.style.top = `${p.y.toFixed(1)}px`;
    }
    for (const [id, node] of this.nodes) {
      if (alive.has(id)) continue;
      node.remove();
      this.nodes.delete(id);
    }
  }

  private ensure(id: number): HTMLElement {
    const existing = this.nodes.get(id);
    if (existing) return existing;

    const fx = make('div', 'rp rp__fx');
    fx.setAttribute('aria-hidden', 'true');
    // P-096：只放图标，不再挂「修复中」文字和底板
    fx.innerHTML = REPAIR_SVG;
    this.el.append(fx);
    this.nodes.set(id, fx);
    return fx;
  }
}
