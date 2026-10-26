/**
 * 对战模式的 HUD —— 金币、双方核心血量（蓝/红）、四张手牌、胜负。
 *
 * 规矩沿用老模式：DOM 只是世界状态的镜子，不自己算判据。
 * 这里只读 `world.summary()` 与 `world.hand`，以及 App 的 `selectedSlot`。
 */

import { ECONOMY, HAND, type ArenaCard } from './config';
import type { ArenaApp } from './ArenaApp';

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

export interface ArenaHudOptions {
  onSelectCard: (slot: number) => void;
  onRestart: () => void;
}

export class ArenaHud {
  readonly el = make('div', 'ahud');
  private readonly goldText = make('b', 'ahud__gold__num', '5');
  private readonly blueHp = make('i', 'ahud__hp__fill');
  private readonly redHp = make('i', 'ahud__hp__fill');
  private readonly blueText = make('span', 'ahud__hp__num', '');
  private readonly redText = make('span', 'ahud__hp__num', '');
  private readonly cards: HTMLButtonElement[] = [];
  private readonly toast = make('div', 'ahud__toast');
  private readonly end = make('div', 'ahud__end');
  private toastTimer: number | null = null;

  constructor(
    host: HTMLElement,
    private readonly app: ArenaApp,
    private readonly opts: ArenaHudOptions,
  ) {
    const top = make('div', 'ahud__top panel');
    const blue = make('div', 'ahud__hp ahud__hp--blue');
    blue.append(
      make('span', 'ahud__tag', '蓝方（你）'),
      this.barWrap(this.blueHp, this.blueText),
    );
    const red = make('div', 'ahud__hp ahud__hp--red');
    red.append(make('span', 'ahud__tag', '红方（敌）'), this.barWrap(this.redHp, this.redText));
    const gold = make('div', 'ahud__gold');
    gold.append(make('span', 'ahud__tag', '金币'), this.goldText, make('span', 'ahud__gold__cap', `/${ECONOMY.cap}`));
    top.append(blue, gold, red);

    const hand = make('div', 'ahud__hand');
    for (let i = 0; i < HAND.size; i++) {
      const card = make('button', 'ahud__card');
      card.addEventListener('click', () => this.opts.onSelectCard(i));
      this.cards.push(card);
      hand.append(card);
    }

    const hint = make('div', 'ahud__hint', '点一张牌 → 点自己半场放下去。点自家兵营 → 再点地面挪出兵旗。');
    this.el.append(top, hand, hint, this.toast, this.end);
    host.append(this.el);
    this.end.hidden = true;
    this.end.append(
      make('div', 'ahud__end__title', ''),
      make('button', 'ahud__end__btn', '再来一局'),
    );
    (this.end.lastChild as HTMLElement).addEventListener('click', () => this.opts.onRestart());
    this.refresh();
  }

  private barWrap(fill: HTMLElement, num: HTMLElement): HTMLElement {
    const wrap = make('div', 'ahud__hp__bar');
    wrap.append(fill, num);
    num.classList.add('num');
    return wrap;
  }

  say(text: string, tone: 'ok' | 'warn' = 'ok'): void {
    this.toast.textContent = text;
    this.toast.dataset['tone'] = tone;
    this.toast.dataset['on'] = '1';
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.dataset['on'] = '0';
    }, 1800);
  }

  /** 10Hz 由 App 的 onState 调；内容便宜，全量重画。 */
  refresh(): void {
    const s = this.app.world.summary();
    this.goldText.textContent = String(s.gold);
    const frac = (hp: number) => Math.max(0, Math.min(1, hp / s.coreMax));
    this.blueHp.style.width = `${(frac(s.blueCore) * 100).toFixed(1)}%`;
    this.redHp.style.width = `${(frac(s.redCore) * 100).toFixed(1)}%`;
    this.blueText.textContent = `${s.blueCore} · 兵 ${s.units.blue}`;
    this.redText.textContent = `${s.redCore} · 兵 ${s.units.red}`;
    this.goldText.parentElement?.setAttribute('data-full', String(s.gold >= ECONOMY.cap));

    for (let i = 0; i < this.cards.length; i++) this.paintCard(i);

    if (s.outcome !== 'playing') {
      this.end.hidden = false;
      const title = this.end.firstElementChild as HTMLElement;
      title.textContent = s.outcome === 'win' ? '红方核心碎了 —— 你赢了' : '蓝方核心碎了 —— 这局输了';
      title.dataset['outcome'] = s.outcome;
    }
  }

  private paintCard(slot: number): void {
    const el = this.cards[slot]!;
    const card = this.app.world.hand[slot];
    const cd = this.app.world.handCooldown[slot]!;
    const gold = this.app.world.gold.blue;
    el.dataset['selected'] = String(this.app.selectedSlot === slot);
    if (!card) {
      el.dataset['empty'] = '1';
      el.replaceChildren(
        make('span', 'ahud__card__name', '补牌中'),
        make('span', 'ahud__card__cd', `${cd.toFixed(1)}s`),
      );
      el.disabled = true;
      return;
    }
    el.dataset['empty'] = '0';
    el.dataset['affordable'] = String(gold >= card.cost);
    el.disabled = cd > 0 || gold < card.cost;
    el.replaceChildren(
      make('span', 'ahud__card__cost', String(card.cost)),
      make('span', 'ahud__card__name', card.name),
      make('span', 'ahud__card__kind', card.kind === 'building' ? '建筑' : '军队'),
    );
  }

  /** 卡池变了（配卡组以后）再重建卡面；现在只需重画。 */
  setHand(): void {
    this.refresh();
  }

  /** 给外部（比如实机探针）读一眼当前卡面文案。 */
  get cardLabels(): string[] {
    return this.cards.map((c) => c.textContent ?? '');
  }

  /** 用一张卡的说明做长按提示（以后接气泡）。 */
  static describe(card: ArenaCard): string {
    return `${card.name}（${card.cost} 金）· ${card.blurb}`;
  }
}
