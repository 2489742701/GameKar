/**
 * 顶栏资源 —— 金币 / 晶钻 / 面包 / 人口 + 回合牌。
 *
 * 每秒进账写在数字下面，但**面包不写**：它是容积，只在回合结算那一刻跳一次。
 * 这条区别是玩法本身，所以读数上也要看得出来，不能四个资源都挂个"/s"糊过去。
 */

import { RESOURCE_META, type ResourceId } from '@game/config';
import type { GameWorld } from '@game/world/GameWorld';
import { cssColor, formatNumber, formatRate, make, setText, type HudWidget } from './dom';

const ORDER: ResourceId[] = ['gold', 'crystal'];
/** 容积型读数：显示成 现量/上限，不显示速率 */
const STOCK: ResourceId[] = ['bread'];

export class ResourceBar implements HudWidget {
  readonly el = make('div', { class: 'resbar panel' });
  private readonly value = new Map<ResourceId, HTMLElement>();
  private readonly rate = new Map<ResourceId, HTMLElement>();
  private popValue!: HTMLElement;
  private popRate!: HTMLElement;
  private round!: HTMLElement;

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

    for (const id of STOCK) {
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

    this.round = make('span', { class: 'resbar__round num' });
    this.el.append(this.round, make('span', { class: 'resbar__title', text: 'GAMEKAR' }));
  }

  refresh(): void {
    const rates = this.world.incomeRates();
    for (const id of ORDER) {
      setText(this.value.get(id)!, formatNumber(this.world.resources[id], 0));
      setText(this.rate.get(id)!, formatRate(rates[id] ?? 0));
    }
    const used = this.world.populationUsed();
    // 分母用快照：这一回合真正能用的人口，不是"理论上有多少房"
    setText(this.popValue, `${used}/${this.world.approved}`);
    setText(this.popRate, used > this.world.approved ? `缺 ${used - this.world.approved}` : '人手齐');

    for (const id of STOCK) {
      setText(this.value.get(id)!, `${Math.floor(this.world.resources[id])}/${this.world.breadCap}`);
      setText(this.rate.get(id)!, `每回合 +${this.world.breadPerRound()}`);
    }

    const left = Math.ceil(this.world.phaseSecondsLeft);
    setText(
      this.round,
      this.world.phase === 'prep'
        ? `第 ${this.world.roundIndex} 回合 · 准备 ${left}s`
        : `第 ${this.world.roundIndex} 回合 · 接敌中`,
    );
  }
}
