/**
 * 来犯预告 —— 敌人从哪儿来，得先告诉玩家。
 *
 * 用户定这条时说的是"每局固定一处，提前预告"。来点本身早就有了（`Combat.spawnAt`，
 * 按 seed 现量挑的边缘可站格），缺的只是屏幕上那一句。
 *
 * 只在准备阶段的**最后 15 秒**出现：更早贴出来没人看，也更晚就没有"该补哪一面"的决策价值。
 * 顶栏那格同时翻成琥珀色，眼睛不用离开手边的按钮也能感到"要来了"。
 */

import { make, setText, type HudWidget } from './dom';
import type { GameWorld } from '@game/world/GameWorld';
import type { Combat } from '@game/systems/Combat';

/** 提前几秒开始预告。 */
export const PREVIEW_SECONDS = 15;

export class RaidPreview implements HudWidget {
  readonly el = make('div', { class: 'raid', attrs: { hidden: '' } });
  private readonly label = make('span', { class: 'raid__label' });
  private readonly clock = make('span', { class: 'raid__clock num' });

  constructor(
    private readonly world: GameWorld,
    private readonly combat: Combat,
    private readonly seed: number,
  ) {
    this.el.append(this.label, this.clock);
  }

  get showing(): boolean {
    return !this.el.hidden;
  }

  /** 10Hz 刷内容；每帧由 place() 搬位置。 */
  refresh(): void {
    const { phase, phaseSecondsLeft, roundIndex } = this.world;
    const soon = phase === 'prep' && phaseSecondsLeft <= PREVIEW_SECONDS;
    this.el.hidden = !soon;
    if (!soon) return;
    setText(this.label, `第 ${roundIndex} 波 · 从这边来`);
    setText(this.clock, `${Math.ceil(phaseSecondsLeft)}s`);
  }

  place(x: number, y: number, inFront: boolean): void {
    if (this.el.hidden) return;
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -140%)`;
    this.el.dataset['off'] = inFront ? '0' : '1';
  }

  /** 来点在哪一格（GameApp 用它做投影）。 */
  get cell() {
    return this.combat.spawnAt(this.seed);
  }
}
