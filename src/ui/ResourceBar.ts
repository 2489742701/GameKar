/**
 * 顶栏资源 —— 金币 / 晶钻 / 人口，三格读数是这局的全部命脉。
 *
 * 每秒进账直接写在数字下面：玩家不必自己算"我盖这座值不值"。
 */

import { RESOURCE_META, type ResourceId } from '@game/config';
import type { GameWorld } from '@game/world/GameWorld';
import { cssColor, formatNumber, formatRate, make, setText, type HudWidget } from './dom';

const ORDER: ResourceId[] = ['gold', 'crystal'];

export class ResourceBar implements HudWidget {
  readonly el = make('div', { class: 'resbar panel' });
  private readonly value = new Map<ResourceId, HTMLElement>();
  private readonly rate = new Map<ResourceId, HTMLElement>();
  private popValue!: HTMLElement;
  private popRate!: HTMLElement;

  constructor(private readonly world: GameWorld) {
    for (const id of ORDER) {
      const meta = RESOURCE_META[id];
      const v = make('span', { class: 'resbar__val' });
      const r = make('span', { class: 'resbar__rate' });
      this.value.set(id, v);
      this.rate.set(id, r);
      this.el.append(
        make('div', { class: 'resbar__item' }, [
          make('i', { class: 'resbar__icon', attrs: { style: `color:${cssColor(meta.color)}` } }),
          v,
          r,
        ]),
      );
    }

    this.popValue = make('span', { class: 'resbar__val' });
    this.popRate = make('span', { class: 'resbar__rate' });
    this.el.append(
      make('div', { class: 'resbar__item' }, [
        make('i', { class: 'resbar__icon', attrs: { style: `color:${cssColor(0xff9ec4)}` } }),
        this.popValue,
        this.popRate,
      ]),
    );

    this.el.append(make('span', { class: 'resbar__title', text: 'GAMEKAR' }));
  }

  refresh(): void {
    const rates = this.world.incomeRates();
    for (const id of ORDER) {
      setText(this.value.get(id)!, formatNumber(this.world.resources[id], 0));
      setText(this.rate.get(id)!, formatRate(rates[id] ?? 0));
    }
    const used = this.world.populationUsed();
    setText(this.popValue, `${used}/${this.world.populationCap}`);
    setText(this.popRate, used >= this.world.populationCap ? '满' : `空 ${this.world.populationFree()}`);
  }
}
