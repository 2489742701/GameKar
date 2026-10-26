/**
 * 数据表自检 —— 卡牌、建筑、模型三张表互相引用，拼错一个字就是线上事故。
 *
 * 这类错误在浏览器里只会表现为"地上多了个看不见的空盒子"，
 * 所以必须在测试里把它拽出来，而不是靠肉眼看截图。
 */

import { describe, expect, it } from 'vitest';
import { BUILDINGS, buildingList } from '@game/data/buildings';
import { CARDS, RARITY_ORDER, STARTER_POOL, cardList } from '@game/data/cards';
import { ModelLibrary } from '@game/models/registry';
import { unitDef } from '@game/data/units';
import { BUILDING_SPECS, CARDS as ARENA_CARDS } from '@arena/config';

const library = new ModelLibrary();

describe('建筑表', () => {
  it('每栋建筑的模型名都在模型库里注册过', () => {
    const missing = buildingList()
      .filter((def) => !library.has(def.model))
      .map((def) => `${def.id} -> ${def.model}`);
    expect(missing).toEqual([]);
  });

  it('键名与 def.id 一致，否则查表会拿到 undefined', () => {
    for (const def of buildingList()) expect(BUILDINGS[def.id]).toBe(def);
    expect(Object.keys(CARDS).every((k) => CARDS[k]!.id === k)).toBe(true);
  });

  it('占地至少一格，建造时间与成本非负，成本不写 0', () => {
    for (const def of buildingList()) {
      expect(def.footprint.cols).toBeGreaterThanOrEqual(1);
      expect(def.footprint.rows).toBeGreaterThanOrEqual(1);
      expect(def.buildSeconds).toBeGreaterThanOrEqual(0);
      expect(def.population).toBeGreaterThanOrEqual(0);
      for (const [resource, amount] of Object.entries(def.cost)) {
        expect(amount!, `${def.id} 的 ${resource} 成本写成了 ${amount}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('卡表与卡池', () => {
  it('卡池概率表加起来是 1', () => {
    const total = RARITY_ORDER.reduce((sum, r) => sum + STARTER_POOL.rates[r], 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('卡池引用的每张卡都存在，且每张卡都进了池子', () => {
    const inPool = new Set(STARTER_POOL.entries.map((e) => e.cardId));
    const unknown = [...inPool].filter((id) => !CARDS[id]);
    expect(unknown).toEqual([]);

    const orphans = cardList().filter((c) => !inPool.has(c.id)).map((c) => c.id);
    expect(orphans).toEqual([]);
    expect(inPool.size).toBe(cardList().length);
  });

  it('建筑卡指向的建筑真的存在', () => {
    for (const card of cardList()) {
      for (const effect of card.effects) {
        if (effect.kind === 'permit') {
          expect(BUILDINGS[effect.buildingId], `${card.id} 指向了不存在的建筑 ${effect.buildingId}`).toBeTruthy();
        }
      }
    }
  });

  it('十连就是九抽的价钱，第十张白送', () => {
    const single = STARTER_POOL.bundle.find((b) => b.count === 1)!.cost.crystal!;
    const ten = STARTER_POOL.bundle.find((b) => b.count === 10)!.cost.crystal!;
    expect(ten).toBe(single * 9);
    expect(ten).toBeLessThan(single * 10);
  });
});


describe('新增兵种（骑士/法师/机器巨人）', () => {
  it('法师有法术弹，机器巨人比普通兵高', () => {
    expect(unitDef('mage').projectile).toBe('magic');
    expect(unitDef('mage').role).toBe('ranged');
    expect(unitDef('mech').heightTiles).toBeGreaterThan(1.45);
    expect(unitDef('mech').hp).toBeGreaterThan(unitDef('orc').hp);
    expect(unitDef('ballista').projectile).toBe('arrow');
  });

  it('民居卡指向真的建筑规格', () => {
    const card = ARENA_CARDS.find((c) => c.id === 'house');
    expect(card?.building).toBe('house');
    expect(BUILDING_SPECS.house.hp).toBeGreaterThan(0);
  });

  it('卡池里的骑士/法师/机器人都指向真的兵种', () => {
    const arenaCards = ['knights', 'mages', 'mech', 'ballista'];
    for (const id of arenaCards) {
      const card = ARENA_CARDS.find((c) => c.id === id);
      expect(card, `卡 ${id}`).toBeTruthy();
      for (const part of card!.squad ?? []) expect(() => unitDef(part.unitId)).not.toThrow();
    }
  });
});
