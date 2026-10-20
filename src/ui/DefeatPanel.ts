/**
 * 判负面板 —— 议事厅被打掉之后要说清楚"撑到第几回合、还剩什么"，并给一条重开的路。
 *
 * 这条面板只在**真被打掉**时出现：判据是 `GameWorld` 发的 `building:destroyed(议事厅)`，
 * 不是"场上找不到主城"（开局前、或还没盖主城的夹具里那都不算输）。
 *
 * 重开走同一个 seed：地图一样、抽卡序列也一样，所以这一把的教训能立刻重来一次。
 * 重开前先把本地存档清掉 —— 不清的话读档会把"已经输了的那局"再端回来。
 */

import { make, type HudWidget } from './dom';

export interface DefeatStats {
  round: number;
  buildings: number;
  enemies: number;
  gold: number;
  crystal: number;
  bread: number;
}

export class DefeatPanel implements HudWidget {
  readonly el = make('div', { class: 'overlay defeat', attrs: { hidden: '' } });
  private readonly lines = make('div', { class: 'defeat__stats' });
  private shown = false;

  constructor(onRestart: () => void) {
    const box = make('div', { class: 'defeat__box panel' }, [
      make('div', { class: 'defeat__title', text: '议事厅塌了' }),
      make('p', {
        class: 'defeat__hint',
        text: '领地的心脏被打掉，这一局到此。同一张地图重来一次 —— 抽卡序列也一样，正好试另一套摆法。',
      }),
      this.lines,
      make('button', { class: 'btn btn--gold defeat__btn', text: '重开这一局', onClick: () => onRestart() }),
    ]);
    this.el.append(box);
  }

  get open(): boolean {
    return this.shown;
  }

  show(stats: DefeatStats): void {
    if (this.shown) return;
    this.shown = true;
    this.el.hidden = false;
    this.lines.replaceChildren(
      row('撑过回合', String(stats.round)),
      row('还剩建筑', String(stats.buildings)),
      row('场上敌人', String(stats.enemies)),
      row('金币 / 晶钻 / 面包', `${Math.floor(stats.gold)} / ${Math.floor(stats.crystal)} / ${Math.floor(stats.bread)}`),
    );
  }

  hide(): void {
    this.shown = false;
    this.el.hidden = true;
  }

  /** 给读数用：面板上那行标题是什么。 */
  get titleText(): string {
    return this.lines.textContent ?? '';
  }
}

function row(key: string, value: string): HTMLElement {
  return make('div', { class: 'defeat__row' }, [
    make('span', { class: 'defeat__k', text: key }),
    make('span', { class: 'defeat__v num', text: value }),
  ]);
}

/** 重开按钮要做的事：清档 + 带着当前 seed 回同一张图。 */
export function restartUrl(seed: number, current: Location): string {
  const params = new URLSearchParams(current.search);
  params.set('seed', String(seed));
  return `${current.pathname}?${params.toString()}`;
}
