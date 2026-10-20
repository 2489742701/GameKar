/**
 * 世界规则 —— 许可、落位判定、经济结算，以及"脚程决定产量"这套采矿模型。
 *
 * 采矿相关的用例都在一块 40x40 的纯草地上跑：
 * 真地形的矿脉位置随机散落，用它测"距离—产量"这种精确关系会有一堆说不清的干扰。
 */

import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { Random } from '@engine/math/Random';
import { ECONOMY, VEIN_WORK } from '@game/config';
import { buildingDef } from '@game/data/buildings';
import { STARTER_POOL } from '@game/data/cards';
import { GachaService } from '@game/gacha/GachaService';
import { GameWorld } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';
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

/** 平地 + 中线一块晶脉。 */
function flatWorld(vein = pos(20, 20)) {
  const map = new TileMap({ cols: 40, rows: 40 });
  const world = new GameWorld(map);
  world.grant('gold', 100_000);
  world.addPopulationCap(200);
  map.setTerrain(vein, 'vein');
  return { map, world, vein };
}

/**
 * 把 2x2 的楼摆在离矿脉正好 d 格的地方。
 * 东侧占地从 矿点+d 开始，最近格就是它 → 距离 d；
 * 西侧要再退一格（矿点-d-1），否则会和东侧那块叠住。
 */
function placeNear(world: GameWorld, id: string, vein: { col: number; row: number }, d: number, side: 'e' | 'w' = 'e') {
  const origin = side === 'e' ? pos(vein.col + d, vein.row) : pos(vein.col - d - 1, vein.row);
  world.addPermits(id, 1);
  const b = world.build(id, origin);
  if (b) b.built = true;
  return b;
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
    world.addPopulationCap(-ECONOMY.basePopulationCap + 3);
    expect(world.build('barracks', spot)).not.toBeNull();
    expect(world.inspectPlacement(buildingDef('farm'), pos(spot.col + 8, spot.row))).toBe('population');
  });

  it('金币不够时给出 cost', () => {
    const { world, spot } = freshWorld();
    world.addPermits('market', 1);
    world.grant('gold', -world.resources.gold);
    expect(world.inspectPlacement(buildingDef('market'), spot)).toBe('cost');
  });

  it('晶脉不再挡几何：能不能盖是另一回事，毁矿要另外确认', () => {
    const { world, map } = freshWorld();
    world.addPermits('farm', 1);
    world.grant('gold', 10_000);
    const vein = [...map].find((t) => t.terrain === 'vein' && map.isFree(t.pos))!;

    expect(world.inspectPlacement(buildingDef('farm'), vein.pos)).toBeNull();
    expect(world.veinsUnder(vein.pos, 2, 2).length).toBe(1);
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

  it('民居把人口上限抬起来，拆掉再落回去', () => {
    const { world, spot } = freshWorld();
    world.addPermits('house', 2);
    const base = world.populationCap;

    const house = world.build('house', spot)!;
    expect(world.populationCap).toBe(base + buildingDef('house').populationCap!);

    world.demolish(house.id);
    expect(world.populationCap).toBe(base);
  });

  it('卡牌给的上限和建筑给的是叠加的，两条路都算进同一本账', () => {
    const { world, spot } = freshWorld();
    world.addPermits('house', 1);
    const base = world.populationCap;

    world.addPopulationCap(5);
    expect(world.populationCap).toBe(base + 5);

    world.build('house', spot);
    expect(world.populationCap).toBe(base + 5 + buildingDef('house').populationCap!);
  });
});

describe('采矿：产量是脚程算出来的', () => {
  // 矿井：速度 1.2 格/秒、每趟 2 晶钻。往返 = 2×格数，所以
  //   d=1 → 1.2/2×2 = 1.2   d=3 → 1.2/6×2 = 0.4   d=6 → 1.2/12×2 = 0.2
  // 这些数是手算的，不是把产品公式抄一遍，否则公式写错也照样绿。
  it.each([
    [1, 1.2],
    [3, 0.4],
    [6, 0.2],
  ])('矿在 %i 格外 → 每秒 %s 晶钻', (d, expected) => {
    const { world, vein } = flatWorld();
    const mine = placeNear(world, 'mine', vein, d)!;

    expect(world.claimsOf(mine)).toHaveLength(1);
    expect(world.claimsOf(mine)[0]!.tiles).toBe(d);
    expect(world.yieldOf(mine).crystal!).toBeCloseTo(expected, 5);
  });

  it('超出脚程范围就不派人：产量归零，说明里也说没找到矿', () => {
    const { world, vein } = flatWorld();
    const mine = placeNear(world, 'mine', vein, VEIN_WORK.reach + 1)!;

    expect(world.claimsOf(mine)).toHaveLength(0);
    expect(world.yieldOf(mine).crystal ?? 0).toBe(0);
  });

  it('精炼厂靠的是小人走得快：同样 3 格远，比矿井高一大截', () => {
    const a = flatWorld();
    const mine = placeNear(a.world, 'mine', a.vein, 3)!;
    const mineRate = a.world.yieldOf(mine).crystal!;

    const b = flatWorld();
    const refinery = placeNear(b.world, 'refinery', b.vein, 3)!;
    const refineryRate = b.world.yieldOf(refinery).crystal!;

    expect(mineRate).toBeCloseTo(0.4, 5);
    // 3.2/6×2.2
    expect(refineryRate).toBeCloseTo(1.173333, 4);
    expect(refineryRate / mineRate).toBeGreaterThan(2.5);
  });

  it('一条晶脉只归一栋楼，第二栋挤不进去', () => {
    const { world, vein } = flatWorld();
    const first = placeNear(world, 'mine', vein, 1, 'e')!;
    const second = placeNear(world, 'mine', vein, 1, 'w')!;

    expect(world.claimsOf(first)).toHaveLength(1);
    expect(world.claimsOf(second)).toHaveLength(0);
    expect(world.yieldOf(second).crystal ?? 0).toBe(0);
  });

  it('包工上限是真的：四条矿也只采两条', () => {
    const map = new TileMap({ cols: 40, rows: 40 });
    const world = new GameWorld(map);
    world.grant('gold', 100_000);
    world.addPopulationCap(50);
    for (let d = 1; d <= 4; d++) map.setTerrain(pos(20 + d, 20), 'vein');

    const mine = placeNear(world, 'mine', pos(19, 20), 0)!;
    expect(world.claimsOf(mine)).toHaveLength(buildingDef('mine').veinWork!.capacity);

    const refinery = placeNear(world, 'refinery', pos(19, 24), 0)!;
    expect(world.claimsOf(refinery)).toHaveLength(4 - buildingDef('mine').veinWork!.capacity);
  });

  it('拆掉之后矿脉放出来，下一栋接得住', () => {
    const { world, vein } = flatWorld();
    const first = placeNear(world, 'mine', vein, 1, 'e')!;
    const second = placeNear(world, 'mine', vein, 1, 'w')!;
    expect(world.claimsOf(second)).toHaveLength(0);

    world.demolish(first.id);
    expect(world.claimsOf(second)).toHaveLength(1);
  });
});

describe('压在晶脉上要先确认', () => {
  it('没同意就盖不下去，而且许可和地块都不动', () => {
    const { world, map, vein } = flatWorld();
    world.addPermits('mine', 1);

    expect(world.build('mine', vein)).toBeNull();
    expect(world.buildings.size).toBe(0);
    expect(world.permitCount('mine')).toBe(1);
    expect(map.terrainAt(vein)).toBe('vein');
  });

  it('同意之后楼盖起来，晶脉永久变成裸土、再也采不出东西', () => {
    const { world, map, vein } = flatWorld();
    world.addPermits('mine', 1);

    const mine = world.build('mine', vein, true)!;
    expect(mine).not.toBeNull();
    mine.built = true;

    expect(map.terrainAt(vein)).toBe(VEIN_WORK.ruinedTerrain);
    expect(world.claimsOf(mine)).toHaveLength(0);
    expect(world.yieldOf(mine).crystal ?? 0).toBe(0);
  });

  it('毁矿会广播出去，视图才能重涂地块、撤走矿簇', () => {
    const { world, vein } = flatWorld();
    const seen: number[] = [];
    world.bus.on('vein:destroyed', (cells) => cells.forEach((c) => seen.push(c.col * 100 + c.row)));
    world.addPermits('tower', 1);

    // 没同意 → 既没盖成也没毁矿，不该有广播
    expect(world.build('tower', vein)).toBeNull();
    expect(seen).toHaveLength(0);

    // 同意之后才真的毁，广播一次、一格
    expect(world.build('tower', vein, true)).not.toBeNull();
    expect(seen).toEqual([vein.col * 100 + vein.row]);
  });

  it('没压到矿就不该发这条广播', () => {
    const { world, vein } = flatWorld();
    let fired = 0;
    world.bus.on('vein:destroyed', () => fired++);
    world.addPermits('mine', 1);

    expect(world.build('mine', pos(vein.col + 2, vein.row))).not.toBeNull();
    expect(fired).toBe(0);
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

    world.tick(1);
    expect(farm.built).toBe(true);

    const before = world.resources.gold;
    world.tick(2);
    expect(world.resources.gold - before).toBeCloseTo(rate * 2, 4);
  });

  it('封顶那一刻才派人；绕过 tick 直接改 built 也不能读到旧分配', () => {
    const { world, vein } = flatWorld();
    const mine = placeNear(world, 'mine', vein, 1)!;

    // 先让缓存算一遍"还没封顶"，再把封顶这件事直接写上去 ——
    // 真实对局里只有 tick 会改 built，但测试、回放快进、调试台都会绕过它
    mine.built = false;
    expect(world.claimsOf(mine)).toHaveLength(0);
    expect(world.incomeRates().crystal).toBe(0);

    mine.built = true;
    expect(world.claimsOf(mine)).toHaveLength(1);
    expect(world.incomeRates().crystal).toBeCloseTo(1.2, 5);
  });

  it('抽到的经济卡把永久产出叠进同一张账', () => {
    const { world } = freshWorld();
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
  });

  it('人口上限决定能同时养几栋占人的楼', () => {
    const { world, spot } = freshWorld();
    world.addPermits('market', 5);
    world.grant('gold', 100_000);
    const cost = buildingDef('market').population;
    let placed = 0;

    for (let i = 0; i < 5; i++) {
      if (world.build('market', pos(spot.col + i * 2 + 4, spot.row))) placed++;
    }
    expect(placed).toBe(Math.floor(world.populationCap / cost));
    expect(world.populationUsed()).toBe(placed * cost);
  });
});
