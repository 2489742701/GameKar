import { describe, expect, it } from 'vitest';
import { Random } from '@engine/math/Random';
import { GachaService } from '@game/gacha/GachaService';
import { CARDS, RARITY_ORDER, STARTER_POOL, type Rarity } from '@game/data/cards';

const rank = (r: Rarity) => RARITY_ORDER.indexOf(r);
const service = (seed: number) => new GachaService(STARTER_POOL, new Random(seed));

/** 关掉保底的卡池：概率表是否诚实，只有在这种条件下才测得出来。 */
const NO_PITY = { ...STARTER_POOL, pity: { rarity: 'epic' as Rarity, within: 1_000_000 } };

describe('抽卡概率', () => {
  it('无保底时，实测命中率贴住卡池概率表（±0.8%）', () => {
    const gacha = new GachaService(NO_PITY, new Random(20261019));
    const outcomes = gacha.roll(60_000);

    const counts = new Map<Rarity, number>();
    for (const o of outcomes) counts.set(o.card.rarity, (counts.get(o.card.rarity) ?? 0) + 1);

    for (const rarity of RARITY_ORDER) {
      const observed = (counts.get(rarity) ?? 0) / outcomes.length;
      const claimed = STARTER_POOL.rates[rarity];
      expect(Math.abs(observed - claimed)).toBeLessThan(0.008);
    }
  });

  it('保底：任意连续 10 抽里至少出一张精英及以上', () => {
    const gacha = service(31415);
    let gap = 0;
    let worst = 0;
    for (const o of gacha.roll(20_000)) {
      gap = rank(o.card.rarity) >= 2 ? 0 : gap + 1;
      worst = Math.max(worst, gap);
    }
    expect(worst).toBeLessThanOrEqual(STARTER_POOL.pity.within);
  });

  it('卡池里每一张卡都真的抽得到（权重与稀有度没写拧）', () => {
    const gacha = service(2718);
    const seen = new Set(gacha.roll(80_000).map((o) => o.card.id));
    const missing = STARTER_POOL.entries.map((e) => e.cardId).filter((id) => !seen.has(id));
    expect(missing).toEqual([]);
  });

  it('每张卡的 rarity 与它在卡池里的档位一致，否则低档永远抽不到', () => {
    for (const entry of STARTER_POOL.entries) {
      const card = CARDS[entry.cardId];
      expect(card, `卡池引用了不存在的卡 ${entry.cardId}`).toBeTruthy();
      expect(RARITY_ORDER).toContain(card!.rarity);
      expect(card!.effects.length).toBeGreaterThan(0);
    }
  });
});

describe('抽卡报价与记账', () => {
  it('整包价走折扣，凑不出整包时退回单抽价乘次数', () => {
    const gacha = service(1);
    expect(gacha.priceFor(1)).toEqual({ crystal: 60 });
    expect(gacha.priceFor(10)).toEqual({ crystal: 540 });
    expect(gacha.priceFor(3)).toEqual({ crystal: 180 });
  });

  it('「新」只在第一次出现，重复抽到不再标新', () => {
    const gacha = service(555);
    const firstSeen = new Map<string, number>();
    for (const o of gacha.roll(4000)) {
      const previous = firstSeen.get(o.card.id);
      if (previous === undefined) expect(o.isNew).toBe(true);
      else expect(o.isNew).toBe(false);
      firstSeen.set(o.card.id, (previous ?? 0) + 1);
    }
  });

  it('同 seed 同序列：回放和分享码靠的就是这条', () => {
    const a = service(987654).roll(500).map((o) => o.card.id);
    const b = service(987654).roll(500).map((o) => o.card.id);
    expect(a).toEqual(b);
  });

  it('十连里保底计数在出精英后归零，不出就一路累加', () => {
    const gacha = service(112233);
    let since = 0;
    for (let i = 0; i < 10; i++) {
      const [outcome] = gacha.roll(1);
      const hit = rank(outcome!.card.rarity) >= 2;
      expect(gacha.guaranteeCounter).toBe(hit ? 0 : since + 1);
      since = gacha.guaranteeCounter;
    }
  });
});
