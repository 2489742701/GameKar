/**
 * 塔顶菜单 —— 点一座塔，头顶弹「升级」「拆除」；拆除要再确认一次才动手。
 *
 * 为什么不做成全屏幕模态：塔是要一边看战场一边操作的，模态会把战场盖住，
 * 而"确认拆除"只需要一个就地展开的第二层，按下去就收起。
 * 这也是触屏上最稳的形状：两个大按钮 + 一次反悔的机会。
 */

import type { Combat } from '@game/systems/Combat';
import type { Building } from '@game/world/GameWorld';
import { lift } from './BuildingBars';
import { make, setFlag, setText, type HudWidget } from './dom';

/** 菜单让开血条与徽章两档，正好压在它们上面。 */
const MENU_LIFT = 62;

export interface MenuActions {
  onUpgrade(building: Building): void;
  /** 二级确认之后才真拆 */
  onDemolish(building: Building): void;
  /** 有兵的楼：切 自动锁敌 / 守卫定点 */
  onStance(building: Building, stance: 'hunt' | 'guard'): void;
}

export class BuildingMenu implements HudWidget {
  readonly el = make('div', { class: 'bmenu panel', attrs: { hidden: '' } });
  private readonly upgradeBtn = make('button', { class: 'bmenu__btn bmenu__btn--up' });
  private readonly demolishBtn = make('button', { class: 'bmenu__btn bmenu__btn--danger' });
  private readonly confirmRow = make('div', { class: 'bmenu__confirm' });
  /** 站姿那一行：只有带兵的楼才出现 */
  private readonly stanceRow = make('div', { class: 'bmenu__stance' });
  private readonly stanceBtns = new Map<'hunt' | 'guard', HTMLElement>();
  private target: Building | null = null;
  private confirming = false;

  constructor(
    private readonly actions: MenuActions,
    private readonly combat?: Combat,
  ) {
    for (const [key, label] of [
      ['hunt', '自动锁敌'],
      ['guard', '守卫定点'],
    ] as const) {
      const btn = make('button', {
        class: 'bmenu__btn bmenu__btn--thin',
        text: label,
        onClick: () => {
          if (this.target) this.actions.onStance(this.target, key);
        },
      });
      this.stanceBtns.set(key, btn);
      this.stanceRow.append(btn);
    }
    this.upgradeBtn.addEventListener('click', () => {
      if (this.target) this.actions.onUpgrade(this.target);
    });
    this.demolishBtn.addEventListener('click', () => {
      // 第一下只展开第二层，什么都不拆
      this.confirming = true;
      this.render();
    });
    this.confirmRow.append(
      make('button', {
        class: 'bmenu__btn bmenu__btn--danger',
        text: '确定拆除',
        onClick: () => {
          const target = this.target;
          this.confirming = false;
          if (target) this.actions.onDemolish(target);
          this.show(null);
        },
      }),
      make('button', {
        class: 'bmenu__btn',
        text: '取消',
        onClick: () => {
          this.confirming = false;
          this.render();
        },
      }),
    );
    this.el.append(this.upgradeBtn, this.stanceRow, this.demolishBtn, this.confirmRow);
  }

  get targetBuilding(): Building | null {
    return this.target;
  }

  /**
   * 现在**所有楼都弹菜单**：塔升级加强火力，其它楼升级加快生产（用户："各建筑物、房屋都可以升级"）。
   * 议事厅能升级但不能拆（没有拆除按钮）。
   */
  show(building: Building | null): void {
    this.target = building;
    if (!this.target) this.confirming = false;
    this.el.hidden = this.target === null;
    this.render();
  }

  private render(): void {
    const b = this.target;
    if (!b) return;
    this.confirmRow.hidden = !this.confirming;
    this.upgradeBtn.hidden = this.confirming;
    this.stanceRow.hidden = this.confirming || !(b.def.squad && b.def.squad.length > 0);
    // 议事厅不能拆：按钮根本不出现（和选中卡片同一条规矩）
    this.demolishBtn.hidden = this.confirming || !!b.def.unique;
    if (this.confirming) return;

    const price = this.combat?.upgradePrice(b) ?? null;
    setText(this.upgradeBtn, price ? `升级 Lv${b.level + 1} · 金${price.gold}${price.crystal ? ` 水${price.crystal}` : ''}` : '已满级');
    setFlag(this.upgradeBtn, 'maxed', !price);

    setText(this.demolishBtn, `拆除 ${b.def.name}`);
    for (const [key, btn] of this.stanceBtns) setFlag(btn, 'active', b.stance === key);
  }

  /** GameApp 每次升级后把最新等级写进来，避免菜单自己留一份旧账。 */
  readonly levels = new Map<number, number>();

  place(x: number, y: number, visible: boolean): void {
    if (!visible) {
      this.el.hidden = true;
      return;
    }
    if (!this.target) return;
    this.el.hidden = false;
    this.el.style.transform = lift(x, y, MENU_LIFT);
  }

  forget(id: number): void {
    if (this.target?.id === id) this.show(null);
  }
}
