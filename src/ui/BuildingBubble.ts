/**
 * 建筑气泡 —— 长按一个建筑，说明就钉在它头顶。
 *
 * 内容跟着"查的是哪栋"重建一次，位置每帧跟着相机投影走：
 * 内容重建便宜，位置重建贵，两件事分开才不会拖慢渲染。
 */

import type { Building, GameWorld } from '@game/world/GameWorld';
import { buildingFacts } from './facts';
import { make, setText, type HudWidget } from './dom';

export class BuildingBubble implements HudWidget {
  readonly el = make('div', { class: 'bubble panel', attrs: { hidden: '' } });
  private readonly name = make('div', { class: 'bubble__name' });
  private readonly lines = make('div', { class: 'bubble__lines' });
  private target: Building | null = null;

  constructor(private readonly world: GameWorld) {
    this.el.append(this.name, this.lines);
  }

  get targetBuilding(): Building | null {
    return this.target;
  }

  show(building: Building | null): void {
    this.target = building;
    if (!building) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    setText(this.name, building.def.name);
    const facts = [...buildingFacts(this.world, building)];
    if (!building.built) facts.push(`建造中 ${Math.round(building.progress * 100)}%`);
    this.lines.replaceChildren(
      make('div', { class: 'bubble__blurb', text: building.def.blurb }),
      ...facts.map((text) => make('div', { class: 'bubble__fact num', text })),
    );
  }

  /** 钉在建筑头顶：(x, y) 是画布 CSS 像素，已由 GameApp 投影好。 */
  place(x: number, y: number, visible: boolean): void {
    if (!visible) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
  }

  /** 楼被拆了、或者选中变了，气泡要自己收起来。 */
  forget(id: number): void {
    if (this.target?.id === id) {
      this.target = null;
      this.el.hidden = true;
    }
  }
}
