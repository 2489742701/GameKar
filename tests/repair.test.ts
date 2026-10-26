/**
 * 修理工与"正在修"标记的锁（P-012）。
 *
 * 这一族最容易骗自己的写法是"派去修就挂锤子"——人还在路上、或者楼已经补满了，
 * 头顶照样亮着锤子。所以每条都从**真实路径**量：议事厅自己放出工匠、走到门口、
 * 真补到血，才允许标记为真。
 */

import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { WORKER } from '@game/config';
import { Combat, REPAIR_MARK_SECONDS } from '@game/systems/Combat';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';
import { buildingFacts } from '@ui/facts';

function arena(): { world: GameWorld; combat: Combat } {
  const world = new GameWorld(new TileMap({ cols: 40, rows: 40 }), { seed: 909 });
  world.grant('gold', 100_000);
  for (const id of ['hall', 'house', 'farm']) world.addPermits(id, 10);
  const hall = world.build('hall', pos(10, 10))!;
  hall.built = true;
  return { world, combat: new Combat({ world, maxUnits: 40 }) };
}

/** 跑若干秒，每步 0.05（与真实模拟同频）。 */
function run(combat: Combat, seconds: number, each?: (t: number) => void): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    combat.update(0.05);
    each?.((i + 1) * 0.05);
  }
}

describe('工匠真的会去修', () => {
  it('伤楼会被补血，速率就是 WORKER.repairPerSecond', () => {
    const { world, combat } = arena();
    const house = world.build('house', pos(13, 10))!;
    house.built = true;
    house.hp = 40; // 民居 200 血，先砍掉一大截

    run(combat, 4); // 工匠从议事厅走到门口大概要一两秒
    const afterWalk = house.hp;
    expect(afterWalk).toBeGreaterThan(40);

    run(combat, 1);
    const healed = house.hp - afterWalk;
    // 议事厅放的是 WORKER.count 个工匠：一秒最多 count × 单人速率
    expect(healed).toBeGreaterThan(0);
    expect(healed).toBeLessThanOrEqual(WORKER.count * WORKER.repairPerSecond + 0.01);
  });

  it('路上不修、到门口才修：标记只在真补到血之后出现', () => {
    const { world, combat } = arena();
    const far = world.build('farm', pos(16, 16))!;
    far.built = true;
    far.hp = 30;

    let repairedWhileWalking = false;
    let everRepairing = false;
    run(combat, 12, () => {
      if (combat.isRepairing(far.id)) everRepairing = true;
      if (far.hp > 30 && !combat.isRepairing(far.id)) repairedWhileWalking = true;
    });
    // 血涨的时候一定同时有标记（不存在"在补血但没锤子"的帧）
    expect(repairedWhileWalking).toBe(false);
    expect(everRepairing).toBe(true);
    expect(far.hp).toBeGreaterThan(30);
  });

  it('补满之后锤子自己收起来（标记会过期，不是一直亮）', () => {
    const { world, combat } = arena();
    const house = world.build('house', pos(13, 10))!;
    house.built = true;
    house.hp = house.def.hp;

    run(combat, 4);
    expect(combat.isRepairing(house.id)).toBe(false); // 满血：一次都没补到

    house.hp = house.def.hp - 1;
    let sawMark = false;
    run(combat, 3, () => {
      if (combat.isRepairing(house.id)) sawMark = true;
    });
    expect(sawMark).toBe(true);
    expect(house.hp).toBe(house.def.hp);

    // 已经补满：再跑一小段，标记必须落下去
    run(combat, REPAIR_MARK_SECONDS + 0.2);
    expect(combat.isRepairing(house.id)).toBe(false);
    expect(combat.repairingIds()).toEqual([]);
  });

  /**
   * 一条**没有**的锁，写在这里免得下次有人以为它被测过：
   * `world.repair(...) > 0` 那道判断（"真补到血才打标记"）**测不出来**。
   * 我试过把判断去掉、改成"走到门口就打标记"，6 条用例全绿 ——
   * 因为楼一补满，选目标那一步当帧就不再把 it 当目标，工匠立刻转头回家，
   * 那一段"站在满血楼旁边"的窗口只有一帧，锁抓不到。
   * 所以这道判断是**防御性**的，不是"被锁住"的；被锁住的是这三条可观察性质：
   *   ① 还在路上不亮（下面那条"路上不修"）；② 补满后 0.35 秒内熄灭；③ 拆掉之后不留。
   */
  it('没人受伤时全场零标记（这条能打红"给所有楼都打标记"那种写法）', () => {
    const { world, combat } = arena();
    const house = world.build('house', pos(13, 10))!;
    house.built = true;
    let everMarked = false;
    run(combat, 6, () => {
      if (combat.repairingIds().length > 0) everMarked = true;
    });
    expect(everMarked).toBe(false);
  });
});

describe('读数与锤子同源', () => {
  it('真在修的时候，气泡读数里多一行"修理中 +5/s"', () => {
    const { world, combat } = arena();
    const house = world.build('house', pos(13, 10))!;
    house.built = true;
    house.hp = 50;

    let sawLine = false;
    run(combat, 5, () => {
      if (!combat.isRepairing(house.id)) return;
      const lines = buildingFacts(world, house, undefined, combat);
      if (lines.some((l) => l.includes('修理中'))) sawLine = true;
    });
    expect(sawLine).toBe(true);
    expect(buildingFacts(world, house, undefined, combat).some((l) => l.includes('修理中'))).toBe(
      combat.isRepairing(house.id),
    );
  });
});

describe('读不出来的楼不挂锤子', () => {
  it('楼被拆掉之后，repairingIds 里不会留下它', () => {
    const { world, combat } = arena();
    const house = world.build('house', pos(13, 10))! as Building;
    house.built = true;
    house.hp = 20;
    run(combat, 5);
    world.demolish(house.id);
    run(combat, REPAIR_MARK_SECONDS + 0.3);
    expect(combat.repairingIds()).not.toContain(house.id);
  });
});
