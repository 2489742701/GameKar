import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { Random } from '@engine/math/Random';
import { ECONOMY } from '@game/config';
import { buildingDef } from '@game/data/buildings';
import { STARTER_POOL } from '@game/data/cards';
import { GachaService } from '@game/gacha/GachaService';
import { GameWorld } from '@game/world/GameWorld';
import { findNearestClearSpot, generateTerrain } from '@game/world/TerrainGenerator';

function freshWorld(seed = 20261019) {
  const map = generateTerrain({
    size: { cols: 46, rows: 46 },
    seed,
    veins: 9,
    clearingRadius: 4,
  });
  const world = new GameWorld(map);
  const home = pos(23, 23);
  return { world, map, home, spot: findNearestClearSpot(map, home, 2, 2)! };
}

describe('建造许可与落位判定', () => {
  it('没有许可就是盖不了 —— 这个游戏的建筑全部来自抽卡', () => {
    const { world, spot } = freshWorld();
    expect(world.permitCount('farm')).toBe(0);
    expect(world.inspectPlacement(buildingDef('farm'), spot)).toBe('no-permit');
  });

  it('给了许可就能盖；盖上之后占掉整块 2x2 并扣金币', () => {
    const { world, spot } = freshWorld();
    world.addPermits('farm', 1);
    const goldBefore = world.resources.gold;

    const building = world.build('farm', spot);
    expect(building).not.toBeNull();
    expect(world.resources.gold).toBeCloseTo(goldBefore - buildingDef('farm').cost.gold!, 5);
    expect(world.permitCount('farm')).toBe(0);
    expect(world.map.buildingAt(spot)).toBe(building!.id);
    expect(world.map.buildingAt(pos(spot.col + 1, spot.row + 1))).toBe(building!.id);
  });

  it('议事厅全场唯一，第二座被 unique 拦住', () => {
    const { world, spot } = freshWorld();
    world.addPermits('hall', 2);
    expect(world.build('hall', spot)).not.toBeNull();
    expect(world.inspectPlacement(buildingDef('hall'), pos(spot.col + 6, spot.row))).toBe('unique');
  });

  it('人口不足时给出 population，而不是含糊失败', () => {
    const { world, spot } = freshWorld();
    world.addPermits('barracks', 1);
    world.addPermits('farm', 2);
    // 底储只够几座，先把人口吃干
    world.addPopulationCap(-ECONOMY.basePopulationCap + 3);
    expect(world.build('barracks', spot)).not.toBeNull();
    const far = pos(spot.col + 8, spot.row);
    expect(world.inspectPlacement(buildingDef('farm'), far)).toBe('population');
  });

  it('金币不够时给出 cost', () => {
    const { world, map } = freshWorld();
    world.addPermits('refinery', 1);
    world.grant('gold', -world.resources.gold);
    // 必须拿晶脉格来问：拿普通草地问，先被"地形不允许"挡下，测不到钱这一层
    const vein = [...map].find((t) => t.terrain === 'vein' && map.isFree(t.pos))!;
    expect(world.inspectPlacement(buildingDef('refinery'), vein.pos)).toBe('cost');
  });

  it('精炼厂必须压在晶脉上', () => {
    const { world, map } = freshWorld();
    world.addPermits('refinery', 1);
    world.grant('gold', 10_000);
    const vein = [...map].find((t) => t.terrain === 'vein')!;
    const grass = [...map].find((t) => t.terrain === 'grass' && map.isFree(t.pos))!;

    expect(world.inspectPlacement(buildingDef('refinery'), grass.pos)).toBe('terrain');
    expect(world.inspectPlacement(buildingDef('refinery'), vein.pos)).toBeNull();
  });

  it('拆掉之后地块归还，可以原地重盖', () => {
    const { world, spot } = freshWorld();
    world.addPermits('mine', 2);
    const b = world.build('mine', spot)!;
    expect(world.map.isFree(spot)).toBe(false);
    world.demolish(b.id);
    expect(world.map.isFree(spot)).toBe(true);
    expect(world.inspectPlacement(buildingDef('mine'), spot)).toBeNull();
  });
});

describe('经济结算', () => {
  it('建成之前不产出，封顶之后按秒进账', () => {
    const { world, spot } = freshWorld();
    world.addPermits('farm', 1);
    const farm = world.build('farm', spot)!;
    const rate = buildingDef('farm').yields!.gold!;

    expect(farm.built).toBe(false);
    const idle = world.resources.gold;
    world.tick(buildingDef('farm').buildSeconds - 0.5);
    expect(world.resources.gold).toBeCloseTo(idle, 5);

    world.tick(1.0);
    expect(farm.built).toBe(true);

    const before = world.resources.gold;
    world.tick(2);
    expect(world.resources.gold - before).toBeCloseTo(rate * 2, 4);
  });

  it('盖在晶脉上的矿井吃到翻倍，产出读数与结算同口径', () => {
    const { world, map } = freshWorld();
    world.addPermits('mine', 1);
    const vein = [...map].find((t) => t.terrain === 'vein' && map.isFree(t.pos))!;
    const mine = world.build('mine', vein.pos)!;
    mine.built = true;

    const rate = world.yieldOf(mine).crystal!;
    expect(rate).toBeCloseTo(buildingDef('mine').yields!.crystal! * 2, 5);
    expect(world.incomeRates().crystal).toBeCloseTo(rate, 5);
  });

  it('抽到的经济卡把永久产出叠进同一张账', () => {
    const { world, map } = freshWorld();
    const gacha = new GachaService(STARTER_POOL, new Random(4));
    world.grant('crystal', 100_000);

    const purchase = { count: 50, cost: gacha.priceFor(50), outcomes: gacha.roll(50) };
    const goldFromBuildings = world.incomeRates().gold;
    world.applyPurchase(purchase);

    const cardGold = purchase.outcomes.reduce(
      (sum, o) =>
        sum +
        o.card.effects.reduce(
          (s, e) => (e.kind === 'yield' && e.resource === 'gold' ? s + e.perSecond : s),
          0,
        ),
      0,
    );
    expect(world.incomeRates().gold).toBeCloseTo(goldFromBuildings + cardGold, 5);
    expect(world.buildings.size).toBe(0);
    expect(map.size.cols).toBe(46);
  });

  it('人口上限决定能同时养几栋占人的楼', () => {
    const { world, spot } = freshWorld();
    world.addPermits('market', 5);
    world.grant('gold', 100_000);
    const cost = buildingDef('market').population;
    let placed = 0;

    for (let i = 0; i < 5; i++) {
      const where = pos(spot.col + i * 2 + 4, spot.row);
      if (world.build('market', where)) placed++;
    }
    expect(placed).toBe(Math.floor(world.populationCap / cost));
    expect(world.populationUsed()).toBe(placed * cost);
  });
});
