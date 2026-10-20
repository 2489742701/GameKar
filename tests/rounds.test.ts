/**
 * 回合、面包、田地与塔的锁（P-005 ~ P-008）。
 *
 * 这一族最容易写出"恒真的锁"（比如断一个永远为 0 的数），所以每条都带一个
 * **能改口的假件**：要么配一句反向断言，要么先量一次"不该发生"的那一臂。
 */

import { describe, expect, it } from 'vitest';
import { pos } from '@engine/math/Grid';
import { BREAD, ROUNDS } from '@game/config';
import { buildingDef } from '@game/data/buildings';
import { Combat } from '@game/systems/Combat';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';

/** 40×40 纯草地，钱与许可管够；人口不动底子（6）。 */
function arena(): { world: GameWorld; combat: Combat; at: (i: number) => ReturnType<typeof pos> } {
  const world = new GameWorld(new TileMap({ cols: 40, rows: 40 }));
  world.grant('gold', 100_000);
  world.grant('crystal', 10_000);
  for (const id of ['hall', 'house', 'mill', 'field', 'barracks', 'arrowTower', 'cannonTower', 'magicTower', 'farm']) {
    world.addPermits(id, 40);
  }
  const combat = new Combat({ world, maxUnits: 40 });
  world.raidActive = () => combat.enemiesAlive() > 0;
  return { world, combat, at: (i) => pos(4 + i * 3, 6) };
}

function build(world: GameWorld, id: string, at: ReturnType<typeof pos>): Building {
  const b = world.build(id, at);
  if (!b) throw new Error(`${id} 盖不到 ${at.col},${at.row}`);
  b.built = true;
  b.hp = b.def.hp;
  return b;
}

describe('田地必须贴着磨坊', () => {
  it('空地上盖田地 → no-adjacent；贴到磨坊边上就让盖', () => {
    const { world, at } = arena();
    build(world, 'mill', at(0));
    expect(buildingDef('field').requiresAdjacent).toBe('mill');

    expect(world.inspectPlacement(buildingDef('field'), at(9))).toBe('no-adjacent');
    expect(world.build('field', at(9))).toBeNull();

    // 磨坊 2×2 在 (4,6)-(5,7)，紧贴的格子是 col=6 或 row=8
    const next = pos(6, 6);
    expect(world.inspectPlacement(buildingDef('field'), next)).toBe(null);
    expect(world.build('field', next)).not.toBeNull();
  });

  it('磨坊被拆掉之后，已存在的田地不追溯消失（规则只管盖的那一刻）', () => {
    const { world, at } = arena();
    const mill = build(world, 'mill', at(0));
    const field = build(world, 'field', pos(6, 6));
    world.demolish(mill.id);
    expect(world.buildings.has(field.id)).toBe(true);
  });
});

describe('面包是容积', () => {
  it('一栋民居吃 1 个面包；面包为 0 时盖不了，而且提示里点名"面包"', () => {
    const { world, at } = arena();
    const toasts: string[] = [];
    world.bus.on('toast', ({ text }) => toasts.push(text));
    world.grant('bread', -world.resources.bread);

    expect(world.resources.bread).toBe(0);
    expect(world.inspectPlacement(buildingDef('house'), at(0))).toBe('cost');
    expect(world.build('house', at(0))).toBeNull();
    expect(toasts.join('|')).toContain('面包');

    world.grant('bread', 1);
    const before = world.resources.bread;
    const house = build(world, 'house', at(0));
    expect(house).toBeTruthy();
    expect(before - world.resources.bread).toBe(1);
  });

  it('到顶就不涨：多给的面包不是消失，是压根没进账', () => {
    const { world } = arena();
    expect(world.breadCap).toBe(BREAD.baseCap);
    world.grant('bread', 999);
    expect(world.resources.bread).toBe(BREAD.baseCap);

    build(world, 'mill', pos(4, 6));
    expect(world.breadCap).toBe(BREAD.baseCap + BREAD.capPerMill);
    world.grant('bread', 999);
    expect(world.resources.bread).toBe(BREAD.baseCap + BREAD.capPerMill);
  });

  it('每回合面包 = 主城 2 + 磨坊(1 + 每块邻田 +1)', () => {
    const { world, at } = arena();
    build(world, 'hall', at(0));
    expect(world.breadPerRound()).toBe(BREAD.perRoundFromHall);

    build(world, 'mill', pos(10, 10));
    expect(world.breadPerRound()).toBe(BREAD.perRoundFromHall + BREAD.perRoundPerMill);

    build(world, 'field', pos(12, 10));
    build(world, 'field', pos(11, 12));
    expect(world.breadPerRound()).toBe(
      BREAD.perRoundFromHall + BREAD.perRoundPerMill + 2 * BREAD.perRoundPerAdjacentField,
    );
  });
});

describe('回合节奏', () => {
  it('准备阶段钱包一格不动', () => {
    const { world, at } = arena();
    build(world, 'farm', at(0));
    const before = { ...world.resources };
    world.tick(ROUNDS.prepSeconds - 1);
    expect(world.resources.gold).toBe(before.gold);
    expect(world.phase).toBe('prep');
  });

  it('一回合恰好结算一次，回合号只 +1', () => {
    const { world, at } = arena();
    build(world, 'farm', at(0));
    let settled = 0;
    world.bus.on('round:settled', () => settled++);
    const index = world.roundIndex;

    world.tick(ROUNDS.prepSeconds);
    world.tick(ROUNDS.raidMinSeconds + 0.1);
    expect(settled).toBe(1);
    expect(world.roundIndex).toBe(index + 1);
    expect(world.phase).toBe('prep');
  });

  it('敌人还在场上时不许结算 —— 结算只能由"清完"或超时触发', () => {
    const { world, at } = arena();
    build(world, 'farm', at(0));
    combat_holds(world, true);
    world.tick(ROUNDS.prepSeconds);
    world.tick(ROUNDS.raidMinSeconds + 0.1);
    expect(world.phase).toBe('raid');
    combat_holds(world, false);
    world.tick(0.1);
    expect(world.phase).toBe('prep');
  });

  it('接敌拖过上限也会结算，别让一只卡住的敌人冻住整局', () => {
    const { world, at } = arena();
    build(world, 'farm', at(0));
    combat_holds(world, true);
    world.tick(ROUNDS.prepSeconds);
    world.tick(ROUNDS.raidMaxSeconds + 0.1);
    expect(world.phase).toBe('prep');
  });
});

/** 把 raidActive 钉成常量：回合测试不依赖真敌人，免得波次数值一动就牵连一批用例。 */
function combat_holds(world: GameWorld, active: boolean): void {
  world.raidActive = () => active;
}

describe('塔的弹药、装填与升级', () => {
  it('打空一弹夹之后要装填，装完才恢复；期间一发也不许出', () => {
    const { world, combat, at } = arena();
    const tower = build(world, 'arrowTower', at(0));
    const spec = tower.def.tower!;
    putEnemyNear(combat, tower, 2);

    // 判据写成"上一步结束时是空仓 + 正在装填 ⇒ 这一步不许有新弹丸"。
    // 之前我用"这一步看到的弹丸数"来判，结果每一步都数不准：弹丸在天上活不到 0.2 秒，
    // 0.1 秒的采样会整发漏掉；开火数改用内核的 fired 计数。
    let prevMag = spec.magazine;
    let prevReloading = 0;
    let prevFired = combat.fired;
    let sawReload = false;
    let shotWhileReloading = 0;
    let firedAtEmpty = 0;
    for (let step = 0; step < 200; step++) {
      combat.update(0.1);
      const st = combat.towerState(tower);
      // 上一步结束时是"空仓 + 在装填"，这一步就不该有任何新开火
      if (prevMag === 0 && prevReloading > 0) shotWhileReloading += combat.fired - prevFired;
      if (st.reloading > 0) sawReload = true;
      if (firedAtEmpty === 0 && st.magazine === 0) firedAtEmpty = combat.fired;
      prevMag = st.magazine;
      prevReloading = st.reloading;
      prevFired = combat.fired;
    }

    expect(firedAtEmpty).toBe(spec.magazine); // 一弹夹正好这么多发
    expect(sawReload).toBe(true);
    expect(shotWhileReloading).toBe(0); // 装填期间零发
    expect(combat.fired).toBeGreaterThan(spec.magazine); // 装完之后恢复开火
  });

  it('缺员的塔一发都不打；把人口补上就恢复', () => {
    const { world, combat, at } = arena();
    // 两栋兵营（各 4 人口）就把快照那 6 格吃光，塔最后盖 → 排在后面拿不到人
    for (let i = 0; i < 2; i++) build(world, 'barracks', at(i));
    const tower = build(world, 'arrowTower', at(9));
    putEnemyNear(combat, tower, 2);
    expect(world.isUnderstaffed(tower)).toBe(true);

    combat.update(1);
    expect(combat.liveShots()).toHaveLength(0);

    // 补上容量（9 个人口的需求）：塔排到了人，就该重新开火
    world.addPopulationCap(4);
    expect(world.isUnderstaffed(tower)).toBe(false);
    const foe = combat.liveUnits().find((u) => u.def.faction === 'enemy' && !u.dead);
    if (foe) {
      foe.x = tower.origin.col + 2.5;
      foe.z = tower.origin.row + 0.5;
    }
    combat.update(0.05);
    expect(combat.liveShots().length).toBeGreaterThan(0);
  });

  it('伤害在弹丸落地那一刻才发生，不在开火那一刻', () => {
    const { world, combat, at } = arena();
    const tower = build(world, 'arrowTower', at(0));
    const enemy = putEnemyNear(combat, tower, 3);
    const hpBefore = enemy.hp;

    combat.update(0.01);
    expect(combat.liveShots()).toHaveLength(1);
    expect(enemy.hp).toBe(hpBefore); // 还在飞，血没动

    combat.update(2);
    const totalHp = combat.liveUnits().reduce((n, u) => n + u.hp, 0);
    expect(totalHp).toBeLessThan(hpBefore * 5); // 五个敌人里至少挨了一下
  });

  it('升级只花钱与水晶，不扣许可、不抽卡；Lv3 之后不再收钱', () => {
    const { world, combat, at } = arena();
    const tower = build(world, 'magicTower', at(0));
    const permits = world.permitCount('magicTower');
    const gold = world.resources.gold;

    expect(combat.upgrade(tower)).toBe(true);
    expect(combat.towerState(tower).level).toBe(2);
    expect(world.permitCount('magicTower')).toBe(permits);
    expect(world.resources.gold).toBeLessThan(gold);

    expect(combat.upgrade(tower)).toBe(true);
    expect(combat.upgrade(tower)).toBe(false);
    expect(combat.towerState(tower).level).toBe(3);
  });
});

describe('波次', () => {
  it('同 seed 的来点固定，而且一定落在能站人的格子上', () => {
    const { world, combat } = arena();
    const a = combat.spawnAt(20261020);
    const b = combat.spawnAt(20261020);
    expect(b).toEqual(a);
    const t = world.map.terrainAt(a);
    expect(t).not.toBeNull();
    expect(['grass', 'sand', 'vein']).toContain(t);
  });

  it('第 N 波数量 3+2N，第 2 波起混进远程，第 4 波起混进石怪', () => {
    const { combat } = arena();
    combat.spawnWave(1, 1);
    expect(combat.enemiesAlive()).toBe(5);

    const c2 = arena();
    c2.combat.spawnWave(1, 2);
    expect(c2.combat.enemiesAlive()).toBe(7);
    expect(c2.combat.liveUnits().some((u) => u.def.id === 'shade')).toBe(true);

    const c4 = arena();
    c4.combat.spawnWave(1, 4);
    expect(c4.combat.liveUnits().some((u) => u.def.id === 'golem')).toBe(true);
  });

  it('人数封顶之后再生成就不塞了，但要点数计入 capped', () => {
    const { combat } = arena();
    combat.spawnWave(1, 40); // 一波就把场上灌满
    expect(combat.enemiesAlive()).toBe(ROUNDS.maxRaidUnits);
    expect(combat.capped).toBe(0);

    combat.spawnWave(1, 41); // 第二波一个位置都不剩
    expect(combat.enemiesAlive()).toBe(ROUNDS.maxRaidUnits);
    expect(combat.capped).toBeGreaterThan(0);
  });
});

/** 在塔旁边放一个不动的敌人：位置直接写，不经波次，免得测试跟着来点跑。 */
function putEnemyNear(combat: Combat, tower: Building, tiles: number) {
  combat.spawnWave(1, 1);
  const enemy = combat.liveUnits().find((u) => u.def.faction === 'enemy')!;
  enemy.x = tower.origin.col + tiles + 0.5;
  enemy.z = tower.origin.row + 0.5;
  return enemy;
}
