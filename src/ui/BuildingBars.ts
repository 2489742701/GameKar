/**
 * 头顶条 —— 血、生产、弹夹，三种条共用一个节点、一层投影。
 *
 * 为什么合在一层：它们都挂在同一栋楼头顶，分开做会出现"血条压住读条"这种叠放问题，
 * 也要各自遍历一遍在场的楼。哪些楼该挂条、条上写什么，一律由
 * `systems/Readouts.barWorthies()` 判 —— 这一层不再算第二遍判据。
 *
 * 血是**六格**画的，不是平滑宽度：掉一丝血也至少亮一格（不然"挨了一下"根本看不出来），
 * 硬边也和整套像素界面一致。
 *
 * 刷分两档：内容跟着 10Hz 的 `refresh()` 走（血条不需要 60 帧），
 * 位置每帧跟着相机投影走 —— 与气泡、旗子、徽章同一条规矩。
 */

import type { Combat } from '@game/systems/Combat';
import { barWorthies, readoutOf, type BuildingReadout } from '@game/systems/Readouts';
import type { Building, GameWorld } from '@game/world/GameWorld';
import { make, setText, type HudWidget } from './dom';

/**
 * 三层标记钉在同一栋楼头顶，不各自让开就会叠成一坨：
 * 血条贴楼顶（抬 0），缺员徽章抬 26，塔顶菜单抬 52。
 * 抬升量写在各层自己手里，改一层不会把另一层带跑。
 */
export const BARS_LIFT = 0;

export function lift(x: number, y: number, extra = BARS_LIFT): string {
  return `translate3d(${Math.round(x)}px, ${Math.round(y - extra)}px, 0) translate(-50%, -100%)`;
}

interface BarNode {
  el: HTMLElement;
  hpFill: HTMLElement;
  train: HTMLElement;
  trainFill: HTMLElement;
  trainText: HTMLElement;
  ammo: HTMLElement;
  /** 一排小方块：一发一个 */
  pips: HTMLElement;
  /** 当前这排画了几个格；弹夹容量变了才重建 */
  pipCount: number;
}

export class BuildingBars implements HudWidget {
  readonly el = make('div', { class: 'bars' });
  private readonly nodes = new Map<number, BarNode>();

  constructor(
    private readonly world: GameWorld,
    private readonly combat: Combat,
  ) {}

  /** 10Hz：增删节点并重画内容。 */
  refresh(): void {
    const worth = barWorthies(this.world, this.combat);
    const live = new Set<number>();
    for (const r of worth) {
      live.add(r.id);
      this.paint(this.ensure(r.id), r);
    }
    for (const [id, node] of this.nodes) {
      if (live.has(id)) continue;
      node.el.remove();
      this.nodes.delete(id);
    }
  }

  /** 每帧：只搬位置，不重算内容。 */
  placeAll(locate: (id: number) => { x: number; y: number; inFront: boolean }): void {
    for (const [id, node] of this.nodes) {
      const p = locate(id);
      node.el.hidden = !p.inFront;
      node.el.style.transform = lift(p.x, p.y);
    }
  }

  /** 给信息卡/气泡用的一句读数（同一处算完，两处显示不会打架）。 */
  readoutOf(b: Building): BuildingReadout {
    return readoutOf(this.world, this.combat, b);
  }

  forget(id: number): void {
    this.nodes.get(id)?.el.remove();
    this.nodes.delete(id);
  }

  get count(): number {
    return this.nodes.size;
  }

  private ensure(id: number): BarNode {
    const hit = this.nodes.get(id);
    if (hit) return hit;

    const hpFill = make('i', { class: 'bar__hp__fill' });
    const trainFill = make('i', { class: 'bar__fill' });
    const trainText = make('span', { class: 'bar__text num' });
    const pips = make('div', { class: 'bar__pips' });
    const train = make('div', { class: 'bar__train' }, [trainFill, trainText]);
    /**
     * 弹夹那一格**只有方块**：不写"Lv1 · 弹夹 5/6"。
     * 等级与余量在选中卡片里有完整一行，头顶这条只需要一眼看出"还几发、在不在装"。
     */
    const ammo = make('div', { class: 'bar__ammo' }, [pips]);
    const el = make('div', { class: 'bar' }, [make('div', { class: 'bar__hp' }, [hpFill]), train, ammo]);

    const node: BarNode = { el, hpFill, train, trainFill, trainText, ammo, pips, pipCount: 0 };
    this.el.append(el);
    this.nodes.set(id, node);
    return node;
  }

  /**
   * 弹夹画成**一发一个方块**，装填时逐格点亮。
   *
   * 原来是一条连续进度条：6 发只显示成"一条 66% 的条"，看不出还剩几发、也看不出装到第几发。
   * 方块数跟着 `size` 走（箭塔 6、炮塔 3…），容量变了才重建，不是每帧重建。
   */
  private paintPips(node: BarNode, ammo: NonNullable<BuildingReadout['ammo']>): void {
    if (node.pipCount !== ammo.size) {
      node.pipCount = ammo.size;
      node.pips.replaceChildren(
        ...Array.from({ length: ammo.size }, () => make('i', { class: 'bar__pip' })),
      );
    }
    const kids = node.pips.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i]!.setAttribute('data-on', i < ammo.filled ? '1' : '0');
    }
  }

  private paint(node: BarNode, r: BuildingReadout): void {
    node.hpFill.style.width = `${Math.round(r.hp.frac * 100)}%`;
    node.hpFill.dataset['mid'] = r.hp.frac < 0.5 && r.hp.frac >= 0.25 ? '1' : '0';
    node.hpFill.dataset['low'] = r.hp.frac < 0.25 ? '1' : '0';

    const squadBusy = r.squad !== null && r.squad.alive < r.squad.total;
    node.train.hidden = !squadBusy;
    if (r.squad && squadBusy) {
      node.trainFill.style.width = `${Math.round((r.squad.training ?? 1) * 100)}%`;
      setText(node.trainText, r.squad.line);
    }

    const ammoBusy = r.ammo !== null && (r.ammo.reloading > 0 || r.ammo.left < r.ammo.size);
    node.ammo.hidden = !ammoBusy;
    if (r.ammo && ammoBusy) this.paintPips(node, r.ammo);
  }
}
