/**
 * **世界空间的小锤子按钮 + SVG 修复动画**（2026-11-08 用户："建筑脱战一段时间后，
 * 上面会冒出一个小锤子按钮，点一下就会有 SVG 小动画，锤子在打板子，说明在修复"）。
 *
 * 三条规矩（和这个项目的其它 UI 一样，DOM 只是世界的镜子）：
 * 1. **判据全在逻辑层**：出现条件读 `world.repairEligible()`、动画开关读
 *    `world.isRepairing()`，这里不设 `setTimeout`、不自己记"脱战多久"。
 *    挨打时 `hurtBuilding` 会把 `repairLeft` 清零，动画这一帧就停 —— 不会出现
 *    "楼在挨揍但锤子还在欢快地敲"的假读数。
 * 2. **每帧跟随相机**：按钮是 DOM，锚点是 3D 世界坐标，draw() 里投影一次。
 *    相机转/缩放/平移时不会飘在原地。
 * 3. 只给**玩家阵营**（blue）的楼派单；敌方楼、大本营、施工中的楼由逻辑层挡掉。
 *
 * 动画是纯 SVG + CSS keyframes，不引第三方库、不加载图片。
 */
import { el as make } from '@ui/dom';
import type { ArenaBuilding, Side } from '../types';

/** 按钮上的静态小锤子。 */
const HAMMER_ICON = /* html */ `
  <svg class="rp__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <g transform="rotate(-38 12 12)">
      <rect x="10.6" y="9" width="2.8" height="12" rx="1.3" fill="#8b5a2f" stroke="#4a2f18" stroke-width="0.8"/>
      <rect x="5" y="4" width="14" height="6" rx="1.6" fill="#c9d2dc" stroke="#5b6673" stroke-width="0.9"/>
      <rect x="5" y="4" width="3" height="6" rx="1.2" fill="#e6edf4"/>
    </g>
  </svg>`;

/**
 * 锤子打板子：板子固定，锤子绕柄尾摆动，落到 0° 时锤头正好压在板子上沿，
 * 同一拍闪一下火星。`rp__hammer` / `rp__spark` 的节奏在 arena.css 里共用 0.56s。
 */
const REPAIR_SVG = /* html */ `
  <svg class="rp__svg" viewBox="0 0 56 44" width="64" height="50" aria-hidden="true">
    <rect x="2" y="29" width="52" height="11" rx="2.5" fill="#a4703f" stroke="#5c3b1f" stroke-width="1.6"/>
    <path d="M6 33 h44 M6 37 h44" stroke="#7c512b" stroke-width="0.8" opacity=".65"/>
    <circle cx="10" cy="34.5" r="1.2" fill="#3d4249"/>
    <circle cx="46" cy="34.5" r="1.2" fill="#3d4249"/>
    <g class="rp__spark" stroke="#ffd884" stroke-width="1.9" stroke-linecap="round">
      <path d="M19 26 l-4 -4 M25 24 l0 -6 M31 26 l4 -4"/>
    </g>
    <g class="rp__hammer">
      <rect x="28" y="4" width="4.4" height="27" rx="2" fill="#8b5a2f" stroke="#4a2f18" stroke-width="1"/>
      <rect x="19" y="27" width="20" height="8" rx="2" fill="#c9d2dc" stroke="#5b6673" stroke-width="1.2"/>
      <rect x="19" y="27" width="4" height="8" rx="1.4" fill="#eaf0f6"/>
    </g>
  </svg>`;

interface RepairNode {
  el: HTMLElement;
  btn: HTMLButtonElement;
}

/** App 暴露给这一层的最小接口（避免视图类去翻 three / 私有字段）。 */
export interface RepairViewHost {
  readonly world: {
    readonly buildings: Map<number, ArenaBuilding>;
    repairEligible(b: ArenaBuilding, side: Side): boolean;
    isRepairing(id: number): boolean;
  };
  /** 建筑头顶的世界坐标锚点；楼还没建好 / 已拆返回 null */
  repairAnchorOf(id: number): { x: number; y: number; z: number } | null;
  /** 世界坐标 → 相对 UI 容器的 CSS 像素坐标 */
  projectToScreen(p: { x: number; y: number; z: number }): { x: number; y: number; visible: boolean };
  /** 点锤子：转给逻辑层派单，顺带放个音效/提示 */
  requestRepair(id: number): void;
}

export class RepairButtons {
  readonly el: HTMLElement;
  private readonly nodes = new Map<number, RepairNode>();

  constructor(
    host: HTMLElement,
    private readonly app: RepairViewHost,
    private readonly side: Side = 'blue',
  ) {
    this.el = make('div', 'rp-layer');
    host.append(this.el);
  }

  /** draw() 每帧调一次：投影 + 增删节点 + 切 ready/working。 */
  update(): void {
    const alive = new Set<number>();
    for (const b of this.app.world.buildings.values()) {
      const working = this.app.world.isRepairing(b.id);
      const ready = working ? false : this.app.world.repairEligible(b, this.side);
      if (!working && !ready) continue;

      const anchor = this.app.repairAnchorOf(b.id);
      if (!anchor) continue;
      const p = this.app.projectToScreen(anchor);
      const node = this.ensure(b.id);
      alive.add(b.id);

      node.el.style.display = p.visible ? '' : 'none';
      if (!p.visible) continue;
      node.el.style.left = `${p.x.toFixed(1)}px`;
      node.el.style.top = `${p.y.toFixed(1)}px`;
      const state = working ? 'working' : 'ready';
      if (node.el.dataset['state'] !== state) node.el.dataset['state'] = state;
      node.btn.disabled = working;
    }
    for (const [id, node] of this.nodes) {
      if (alive.has(id)) continue;
      node.el.remove();
      this.nodes.delete(id);
    }
  }

  private ensure(id: number): RepairNode {
    const existing = this.nodes.get(id);
    if (existing) return existing;

    const root = make('div', 'rp');
    root.dataset['state'] = 'ready';
    const btn = make('button', 'rp__btn') as HTMLButtonElement;
    btn.type = 'button';
    btn.title = '脱战修复：点一下让工人把这栋楼敲回去';
    btn.setAttribute('aria-label', '修复这栋建筑');
    btn.innerHTML = HAMMER_ICON;
    /**
     * 指针事件必须停在按钮这一层：PointerInput 收的是容器上的手势，
     * 冒泡上去会被当成"点地图"（选中了牌就放牌、没选就弹血量提示）。
     */
    btn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.app.requestRepair(id);
    });

    const fx = make('div', 'rp__fx');
    fx.setAttribute('aria-hidden', 'true');
    fx.innerHTML = `${REPAIR_SVG}<span class="rp__txt">修复中…</span>`;
    root.append(btn, fx);
    this.el.append(root);

    const node = { el: root, btn };
    this.nodes.set(id, node);
    return node;
  }
}
