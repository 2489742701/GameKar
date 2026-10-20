/**
 * 塔顶菜单 —— 点一座塔，头顶弹「升级」「拆除」；拆除要再确认一次才动手。
 *
 * 为什么不做成全屏幕模态：塔是要一边看战场一边操作的，模态会把战场盖住，
 * 而"确认拆除"只需要一个就地展开的第二层，按下去就收起。
 * 这也是触屏上最稳的形状：两个大按钮 + 一次反悔的机会。
 */

import { buildingName } from '@game/data/buildings';
import type { Building } from '@game/world/GameWorld';
import { make, setFlag, setText, type HudWidget } from './dom';

export interface MenuActions {
  onUpgrade(building: Building): void;
  /** 二级确认之后才真拆 */
  onDemolish(building: Building): void;
}

export class BuildingMenu implements HudWidget {
  readonly el = make('div', { class: 'bmenu panel', attrs: { hidden: '' } });
  private readonly upgradeBtn = make('button', { class: 'bmenu__btn bmenu__btn--up' });
  private readonly demolishBtn = make('button', { class: 'bmenu__btn bmenu__btn--danger' });
  private readonly confirmRow = make('div', { class: 'bmenu__confirm' });
  private target: Building | null = null;
  private confirming = false;

  constructor(private readonly actions: MenuActions) {
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
    this.el.append(this.upgradeBtn, this.demolishBtn, this.confirmRow);
  }

  get targetBuilding(): Building | null {
    return this.target;
  }

  /** 只有塔才弹菜单：别的楼没有可升级的东西，弹了是骗人。 */
  show(building: Building | null): void {
    this.target = building && building.def.tower ? building : null;
    if (!this.target) this.confirming = false;
    this.el.hidden = this.target === null;
    this.render();
  }

  private render(): void {
    const b = this.target;
    if (!b?.def.tower) return;
    const spec = b.def.tower;
    this.confirmRow.hidden = !this.confirming;
    this.upgradeBtn.hidden = this.confirming;
    this.demolishBtn.hidden = this.confirming;
    if (this.confirming) return;

    const level = this.levelOf(b);
    const price = spec.upgrades[level - 1];
    setText(
      this.upgradeBtn,
      price ? `升级 Lv${level + 1} · 金${price.gold}${price.crystal ? ` 水${price.crystal}` : ''}` : '已满级',
    );
    setFlag(this.upgradeBtn, 'maxed', !price);
    setText(this.demolishBtn, `拆除 ${buildingName(b.def.id)}`);
  }

  /** 等级由战斗内核持有，这里只读不改；读不到就按 Lv1 显示。 */
  private levelOf(b: Building): number {
    return this.levels.get(b.id) ?? 1;
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
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
  }

  forget(id: number): void {
    if (this.target?.id === id) this.show(null);
  }
}
