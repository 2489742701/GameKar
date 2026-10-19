/**
 * 抽卡服务 —— 纯逻辑，不碰 DOM 也不碰渲染，所以能单独跑单测。
 *
 * 抽卡顺序：先按概率表掷稀有度，再在该稀有度内按权重挑卡。
 * 这样 UI 上写的概率就是真概率，不会出现"写着 2% 实际 1.4%"的账实不符。
 */

import type { Random } from '@engine/math/Random';
import { CARDS, RARITY_ORDER, type CardDef, type GachaPool, type Rarity } from '@game/data/cards';
import type { ResourceId } from '@game/config';

export interface PullOutcome {
  card: CardDef;
  /** 本次为该卡首次到手 */
  isNew: boolean;
  /** 这一发是否由保底强制抬升 */
  fromPity: boolean;
  /** 全局第几抽（从 1 开始） */
  ordinal: number;
}

export interface Purchase {
  count: number;
  cost: Partial<Record<ResourceId, number>>;
  outcomes: PullOutcome[];
}

const rank = (r: Rarity) => RARITY_ORDER.indexOf(r);

export class GachaService {
  private totalPulls = 0;
  /** 距离上次出「保底稀有度及以上」已经过了几抽 */
  private sinceGuarantee = 0;
  private readonly seen = new Set<string>();

  constructor(
    private readonly pool: GachaPool,
    private readonly rng: Random,
  ) {}

  get pulls(): number {
    return this.totalPulls;
  }

  get guaranteeCounter(): number {
    return this.sinceGuarantee;
  }

  /** 已知卡数，用来在 UI 上写「已收集 x / y」。 */
  get collectedCount(): number {
    return this.seen.size;
  }

  get poolSize(): number {
    return this.pool.entries.length;
  }

  /**
   * 报价：优先用卡池里的整包价（十连打折），凑不出整包时退回单抽价 × 次数。
   */
  priceFor(count: number): Partial<Record<ResourceId, number>> {
    const exact = this.pool.bundle.find((b) => b.count === count);
    if (exact) return { ...exact.cost };

    const unit = this.pool.bundle[0];
    if (!unit) throw new Error(`卡池 ${this.pool.id} 没有定义任何抽取档位`);
    const scaled: Partial<Record<ResourceId, number>> = {};
    for (const [res, amount] of Object.entries(unit.cost)) {
      scaled[res as ResourceId] = (amount ?? 0) * count;
    }
    return scaled;
  }

  roll(count: number): PullOutcome[] {
    const out: PullOutcome[] = [];
    for (let i = 0; i < count; i++) out.push(this.rollOne());
    return out;
  }

  private rollOne(): PullOutcome {
    this.totalPulls++;

    const pity = this.pool.pity;
    const forced = this.sinceGuarantee + 1 >= pity.within;
    const rarity = this.rollRarity(forced ? pity.rarity : null);

    this.sinceGuarantee = rank(rarity) >= rank(pity.rarity) ? 0 : this.sinceGuarantee + 1;

    const card = this.rollCard(rarity);
    const isNew = !this.seen.has(card.id);
    this.seen.add(card.id);

    return { card, isNew, fromPity: forced && rank(rarity) >= rank(pity.rarity), ordinal: this.totalPulls };
  }

  /** forceAtLeast 非空时，只在该稀有度及以上的带里掷，并把概率重新归一。 */
  private rollRarity(forceAtLeast: Rarity | null): Rarity {
    const floor = forceAtLeast ? rank(forceAtLeast) : 0;
    const bands = RARITY_ORDER.filter((r) => rank(r) >= floor);
    const weights = bands.map((r) => ({ item: r, weight: this.pool.rates[r] }));
    return this.rng.weighted({ items: weights });
  }

  /** 稀有度内按权重挑；该档一张卡都没有时，往下降一档而不是抛异常。 */
  private rollCard(rarity: Rarity): CardDef {
    let level = rank(rarity);
    while (level >= 0) {
      const wanted = RARITY_ORDER[level]!;
      const candidates = this.pool.entries
        .map((e) => ({ item: CARDS[e.cardId]!, weight: e.weight }))
        .filter(({ item }) => item.rarity === wanted);
      if (candidates.length > 0) return this.rng.weighted({ items: candidates });
      level--;
    }
    // 卡池里一张卡都没有——这是配置错误，必须炸出来
    throw new Error(`卡池 ${this.pool.id} 没有任何可用卡牌`);
  }
}
