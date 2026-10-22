/**
 * 顶栏资源 —— 金币 / 晶钻 / 面包 / 人口 + 回合牌。
 *
 * 每秒进账写在数字下面，但**面包不写**：它是容积，只在回合结算那一刻跳一次。
 * 这条区别是玩法本身，所以读数上也要看得出来，不能四个资源都挂个"/s"糊过去。
 */

import type { ResourceId } from '@game/config';
import type { GameWorld } from '@game/world/GameWorld';
import { iconEl, resourceIcon, type IconName } from './icons';
import { formatNumber, formatRate, make, setText, type HudWidget } from './dom';

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
  private diffBtn!: HTMLElement;

  constructor(
    private readonly world: GameWorld,
    onTheme?: () => void,
    /** 点一下换档，读数由 Hud 给（顶栏不知道 GameApp，只管显示与转达意图） */
    onCycleDifficulty?: () => void,
    private readonly difficultyLabel?: () => string,
  ) {
    // 图形一律是画出来的像素图标，数字就贴在它右边（原来是四个纯色圆点，分不出金币与面包）
    const item = (name: IconName, value: HTMLElement, rate: HTMLElement): void => {
      this.el.append(make('div', { class: 'resbar__item' }, [iconEl(name), value, rate]));
    };
    const slot = (id: ResourceId): void => {
      const v = make('span', { class: 'resbar__val' });
      const r = make('span', { class: 'resbar__rate' });
      this.value.set(id, v);
      this.rate.set(id, r);
      item(resourceIcon[id]!, v, r);
    };
    for (const id of ORDER) slot(id);
    for (const id of STOCK) slot(id);

    this.popValue = make('span', { class: 'resbar__val' });
    this.popRate = make('span', { class: 'resbar__rate' });
    item('pop', this.popValue, this.popRate);

    this.round = make('span', { class: 'resbar__round num' });
    const themeBtn = make('button', { class: 'resbar__theme', text: '材质', onClick: () => onTheme?.() });
    this.diffBtn = make('button', { class: 'resbar__diff', text: '难度', onClick: () => onCycleDifficulty?.() });
    this.el.append(this.round, this.diffBtn, themeBtn, make('span', { class: 'resbar__title', text: 'GAMEKAR' }));
  }

  refresh(): void {
    if (this.difficultyLabel) setText(this.diffBtn, this.difficultyLabel());
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
