/**
 * 集合旗 —— 钉在集合点上方的一颗按钮。
 *
 * 它是 DOM 不是 3D 件，理由有两条：竖屏上要按得准（按钮有最小尺寸，模型没有），
 * 而且它每帧跟着相机走，投影这件事 GameApp 已经有一份（`screenOfRally`），不再写第二份。
 *
 * 三步全是指尖点按：点旗子 = 收进袋；点袋 = 等一次落点；点地面 = 放下。
 * 悬停、长按一概不用 —— 那两样在触屏上要么没有，要么和别的动作撞车。
 */

import type { Building } from '@game/world/GameWorld';
import { make, setFlag, setText, type HudWidget } from './dom';

const GLYPH = '⚑';

export class RallyFlag implements HudWidget {
  readonly el: HTMLElement;
  private readonly glyph = make('span', { class: 'flag__glyph', text: GLYPH });
  private readonly caption = make('span', { class: 'flag__caption' });
  private target: Building | null = null;

  constructor(onTap: (building: Building) => void) {
    this.el = make(
      'button',
      { class: 'flag', attrs: { 'aria-label': '集合旗' } },
      [this.glyph, this.caption],
    );
    this.el.hidden = true;
    this.el.addEventListener('click', () => {
      if (this.target) onTap(this.target);
    });
  }

  /** 现在挂着的是哪栋的旗；Hud 每帧拿它去投影。 */
  get targetBuilding(): Building | null {
    return this.target;
  }

  /** 交出"该显示哪栋的旗"；null 就收起（没选兵营、或者旗子已经在手里）。 */
  show(building: Building | null): void {
    this.target = building;
    this.el.hidden = building === null;
    if (building) {
      setText(this.caption, building.def.name);
    }
  }

  /** 等落点那一段：旗子还在原地，但要有"在等你点地面"的样子。 */
  setArmed(armed: boolean): void {
    setFlag(this.el, 'armed', armed);
  }

  place(x: number, y: number, visible: boolean): void {
    if (!visible) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = this.target === null;
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
  }

  /** 楼没了，旗子也不许再挂着（不然会点出一栋不存在的兵营）。 */
  forget(id: number): void {
    if (this.target?.id === id) this.show(null);
  }
}
