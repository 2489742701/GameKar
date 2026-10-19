/**
 * 抽卡结算面板 —— 一次购买的"开包"时刻。
 *
 * 概率表直接读卡池，不在 UI 里重写一份数字：
 * 账本和展示只要有一处改动，另一处会自动跟上，不会出现"写着 2% 实际 1.4%"。
 */

import { buildingName } from '@game/data/buildings';
import { RARITY_LABEL, RARITY_ORDER, STARTER_POOL, type CardDef, type Rarity } from '@game/data/cards';
import { RESOURCE_META, type ResourceId } from '@game/config';
import type { Purchase, PullOutcome } from '@game/gacha/GachaService';
import { make, type HudWidget } from './dom';

const STAGGER_MS = 55;

function effectLine(card: CardDef): string {
  return card.effects
    .map((e) => {
      switch (e.kind) {
        case 'permit':
          return `${buildingName(e.buildingId)} 许可 ×${e.count}`;
        case 'grant':
          return `${RESOURCE_META[e.resource].label} +${e.amount}`;
        case 'yield':
          return `${RESOURCE_META[e.resource].label} +${e.perSecond}/s`;
        case 'populationCap':
          return `人口上限 +${e.amount}`;
      }
    })
    .join('　');
}

export class GachaPanel implements HudWidget {
  readonly el = make('div', { class: 'overlay', attrs: { hidden: '' } });
  private readonly grid = make('div', { class: 'gacha__grid' });
  private readonly summary = make('div', { class: 'label' });
  private readonly body = make('div', { class: 'gacha panel' });

  constructor(private readonly onClose: () => void) {
    this.el.append(this.body);
    this.body.append(
      make('div', { class: 'gacha__title' }, [
        make('h2', { text: '开拓卡池' }),
        make('div', { class: 'gacha__rates' }, RARITY_ORDER.map((r) => rateChip(r))),
      ]),
      this.grid,
      this.summary,
      make('button', { class: 'btn btn--gold', text: '收下', onClick: () => this.onClose() }),
    );
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(purchase: Purchase): void {
    this.grid.replaceChildren(
      ...purchase.outcomes.map((outcome, i) => cardNode(outcome, i * STAGGER_MS)),
    );
    this.summary.textContent = summarize(purchase);
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }
}

/** 概率表读卡池本体，UI 里不另存一份数字。 */
function rateChip(rarity: Rarity): HTMLElement {
  return make(
    'span',
    { class: 'chip', attrs: { style: `--rc: var(--r-${rarity})` } },
    [
      make('i', { class: 'dot', dataset: { rarity } }),
      make('span', {
        text: `${RARITY_LABEL[rarity]} ${(STARTER_POOL.rates[rarity] * 100).toFixed(1)}%`,
      }),
    ],
  );
}

function cardNode(outcome: PullOutcome, delay: number): HTMLElement {
  const { card, isNew } = outcome;
  return make(
    'div',
    {
      class: `card${isNew ? ' card--new' : ''}`,
      dataset: { rarity: card.rarity },
      attrs: { style: `--delay:${delay}ms` },
    },
    [
      make('span', { class: 'card__rare', text: RARITY_LABEL[card.rarity] }),
      isNew ? make('span', { class: 'card__dup', text: '新' }) : make('span'),
      make('span', { class: 'card__name', text: card.name }),
      make('span', { class: 'card__kind', text: effectLine(card) }),
    ],
  );
}

/** 一句话账单：这次抽卡到底往世界里添了什么。 */
function summarize(purchase: Purchase): string {
  const permits = new Map<string, number>();
  let popCap = 0;
  const yields = new Map<ResourceId, number>();
  const grants = new Map<ResourceId, number>();

  for (const { card } of purchase.outcomes) {
    for (const e of card.effects) {
      if (e.kind === 'permit') permits.set(e.buildingId, (permits.get(e.buildingId) ?? 0) + e.count);
      else if (e.kind === 'populationCap') popCap += e.amount;
      else if (e.kind === 'yield') yields.set(e.resource, (yields.get(e.resource) ?? 0) + e.perSecond);
      else grants.set(e.resource, (grants.get(e.resource) ?? 0) + e.amount);
    }
  }

  const parts: string[] = [];
  if (permits.size) {
    parts.push(`许可 ${[...permits].map(([id, n]) => `${buildingName(id)}×${n}`).join(' ')}`);
  }
  if (yields.size) {
    parts.push(`产出 ${[...yields].map(([r, v]) => `${RESOURCE_META[r].label}+${v}/s`).join(' ')}`);
  }
  if (grants.size) {
    parts.push(`入库 ${[...grants].map(([r, v]) => `${RESOURCE_META[r].label}+${v}`).join(' ')}`);
  }
  if (popCap) parts.push(`人口上限+${popCap}`);

  const paid = Object.entries(purchase.cost)
    .map(([r, v]) => `${RESOURCE_META[r as ResourceId].label}−${v}`)
    .join(' ');
  return `花费 ${paid} ｜ ${parts.join(' ｜ ') || '这次没有实质收益'}`;
}
