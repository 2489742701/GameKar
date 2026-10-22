/**
 * 回合、面包、田地与塔的锁（P-005 ~ P-008）。
 *
 * 这一族最容易写出"恒真的锁"（比如断一个永远为 0 的数），所以每条都带一个
 * **能改口的假件**：要么配一句反向断言，要么先量一次"不该发生"的那一臂。
 */

import { describe, expect, it } from 'vitest';
import { cellToWorld, pos } from '@engine/math/Grid';
import { BREAD, DIFFICULTY, ROUNDS, type Difficulty } from '@game/config';
import { buildingDef } from '@game/data/buildings';
import { unitDef } from '@game/data/units';
import { Combat, type Unit } from '@game/systems/Combat';
import { GameWorld, type Building } from '@game/world/GameWorld';
import { TileMap } from '@game/world/TileMap';
import { raidPreviewLabel } from '@ui/RaidPreview';

/** 40×40 纯草地，钱与许可管够；人口不动底子（6）。默认正常档。 */
function arena(
  difficulty: Difficulty = 'normal',
  maxUnits = 40,
): { world: GameWorld; combat: Combat; at: (i: number) => ReturnType<typeof pos> } {
  const world = new GameWorld(new TileMap({ cols: 40, rows: 40 }));
  world.grant('gold', 100_000);
  world.grant('crystal', 10_000);
  for (const id of ['hall', 'house', 'mill', 'field', 'barracks', 'arrowTower', 'cannonTower', 'magicTower', 'farm']) {
    world.addPermits(id, 40);
  }
  const combat = new Combat({ world, maxUnits, difficulty });
  world.raidActive = () => combat.engaged();
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

  /**
   * 档位表钉死。所有行为锁里的期望值都写**字面数**，不从 DIFFICULTY 反推 ——
   * 不然就是"两边一起错"的恒真锁（这张表上我先踩过一次：capOnField 改小，锁照样绿）。
   */
  it('三档的表钉死：出兵基数/成长、场上上限、每组几只、组间隔、来点处数、主城偏置、急不急', () => {
    expect(DIFFICULTY.easy).toMatchObject({
      waveBase: 2, waveGrowth: 0.5, capOnField: 20, burstSize: 2, burstGapSeconds: 5,
      spawnPoints: 3, hallBias: 0, engageTroops: false, strikePauseSeconds: 1.2,
    });
    expect(DIFFICULTY.normal).toMatchObject({
      waveBase: 4, waveGrowth: 1.2, capOnField: 32, burstSize: 4, burstGapSeconds: 4,
      spawnPoints: 1, hallBias: 2, engageTroops: false, strikePauseSeconds: 0,
    });
    expect(DIFFICULTY.hard).toMatchObject({
      waveBase: 6, waveGrowth: 2, capOnField: 40, burstSize: 6, burstGapSeconds: 2,
      spawnPoints: 2, hallBias: 4, engageTroops: true, strikePauseSeconds: 0,
    });
    // 兵种自己的攻击间隔一个都没被档位改动 —— 难度只许动"来敌节奏"
    expect(unitDef('raider').cooldown).toBe(1.6);
    expect(unitDef('shade').cooldown).toBe(1.25);
    expect(unitDef('golem').cooldown).toBe(2.1);
    expect(unitDef('raider').attack).toBe(6);
    expect(unitDef('raider').hp).toBe(40);
  });

  it('来敌计划读档位表：正常档第 1 波 4 只，第 3 波起混远程、第 5 波起混石怪', () => {
    const { combat } = arena();
    expect(combat.difficulty).toBe('normal');
    expect(combat.raidPlan(1)).toEqual(['raider', 'raider', 'raider', 'raider']);
    expect(combat.raidPlan(2).every((id) => id === 'raider')).toBe(true);
    expect(combat.raidPlan(3).filter((id) => id === 'shade')).toHaveLength(1);
    expect(combat.raidPlan(5).filter((id) => id === 'golem')).toHaveLength(1);
    // 简单更慢更少、困难更多更早混兵：三档必须真的不是同一张表
    expect(arena('easy').combat.raidPlan(1)).toHaveLength(2);
    expect(arena('hard').combat.raidPlan(1)).toHaveLength(6);
    expect(arena('easy').combat.raidPlan(3).every((id) => id === 'raider')).toBe(true);
    expect(arena('hard').combat.raidPlan(2).filter((id) => id === 'shade').length).toBeGreaterThan(0);
  });

  /** 纯函数判据：几处来点就得说几处 —— 这句不能一直写"从这边来"。 */
  it('预告文案说实话：一处写"从这边来"，多处写"从 N 处来"', () => {
    expect(raidPreviewLabel(3, 1)).toBe('第 3 波 · 从这边来');
    expect(raidPreviewLabel(3, 3)).toBe('第 3 波 · 从 3 处来');
    // 文案里的 N 与真来点表对齐：简单 3 处、正常 1 处、困难 2 处
    expect(arena('easy').combat.spawnPointsOf(20261020)).toHaveLength(3);
    expect(arena('normal').combat.spawnPointsOf(20261020)).toHaveLength(1);
    expect(arena('hard').combat.spawnPointsOf(20261020)).toHaveLength(2);
  });

  /** 新增口径：一波不是一次塞完，是分成几涌按间隔进（"慢慢出"就是这条）。 */
  it('一波分几涌进场：正常档第 2 波先落 4 只，隔 4 秒再落第 5 只', () => {
    const { combat } = arena();
    expect(combat.raidPlan(2)).toHaveLength(5);
    combat.spawnWave(1, 2);
    expect(combat.enemiesAlive()).toBe(4); // 第一涌
    expect(combat.burstsPending()).toBe(1); // 第 5 只还在路上
    expect(combat.engaged()).toBe(true); // 后面还有涌，这一刻不算"清场"

    combat.update(4.1);
    expect(combat.enemiesAlive()).toBe(5);
    expect(combat.burstsPending()).toBe(0);
  });

  it('简单档从 3 处边缘同时来；正常档只从 1 处；同一 seed 清单一定', () => {
    const a = arena('easy');
    const b = arena('easy');
    const pts = a.combat.spawnPointsOf(20261020);
    expect(pts).toHaveLength(3);
    expect(JSON.stringify(pts)).toBe(JSON.stringify(b.combat.spawnPointsOf(20261020)));
    expect(pts[0]).toEqual(a.combat.spawnAt(20261020));
    for (const p of pts) expect(['grass', 'sand', 'vein']).toContain(a.world.map.terrainAt(p));
    expect(arena('normal').combat.spawnPointsOf(20261020)).toHaveLength(1);
  });

  /**
   * 改口的旧锁（P-012）：原来用「spawnWave 一波灌满 40 人再看 capped」验引擎上限，
   * 现在波次大小由档位表夹住（正常档封顶 32），灌不满引擎上限了，
   * 所以把引擎上限本身调小来验同一件事：装不下的那几只要记在 capped 上。
   */
  it('波次封顶在 32（正常档）；引擎 maxUnits 更小时照样拦，塞不下的记进 capped', () => {
    const { combat } = arena();
    expect(combat.raidPlan(40)).toHaveLength(32);

    const tight = arena('normal', 3);
    tight.combat.spawnWave(1, 1);
    expect(tight.combat.enemiesAlive()).toBe(3);
    expect(tight.combat.capped).toBeGreaterThan(0);
  });

  /**
   * 简单档的"不急"（strikePauseSeconds）单独钉一条：同一只兽人、同一栋楼、同样 20 秒，
   * 只让档位差在它身上 —— 兵种自己的攻击间隔没改，改的是打完一下之后的停顿。
   */
  it('简单档的敌人打一下要喘：同一只兽人 20 秒，掉的楼血比正常档少', () => {
    const chew = (difficulty: Difficulty) => {
      const { world, combat } = arena(difficulty);
      const farm = build(world, 'farm', pos(4, 6));
      const fc = cellToWorld(world.rallyOf(farm));
      const raider: Unit = {
        id: 7001, def: unitDef('raider'), hp: 40, x: fc.x - 1.5, z: fc.z,
        home: null, cooldown: 0, specialIn: 0, stun: 0, dead: false, deadFor: 0, knockX: 0, knockZ: 0,
      };
      combat.units.push(raider);
      for (let i = 0; i < 200; i++) combat.update(0.1);
      return 200 - farm.hp;
    };
    const easy = chew('easy');
    const normal = chew('normal');
    expect(normal).toBeGreaterThan(0); // 正常档真咬动了（不是两个 0 互等）
    expect(easy).toBeGreaterThan(0);
    expect(easy).toBeLessThan(normal); // 喘 1.2 秒 ⇒ 同样的 20 秒少拆一截
  });

  /** 困难档新行为：远程敌人会转头射你的兵。正常档不射 —— 两头各断一次，防"空锁"。 */
  it('困难档的暗影先射你的骑士；正常档的暗影只拆楼', () => {
    const run = (difficulty: Difficulty) => {
      const { world, combat, at } = arena(difficulty);
      // 用田庄当目标：它不会还手，免得塔把测试用的敌人先打死，两头都"没挨打"而假绿
      const farm = build(world, 'farm', at(0));
      const shade: Unit = {
        id: 5001, def: unitDef('shade'), hp: 24,
        x: farm.origin.col + 1.5, z: farm.origin.row + 0.5,
        home: null, cooldown: 0, specialIn: 0, stun: 0, dead: false, deadFor: 0, knockX: 0, knockZ: 0,
      };
      const knight: Unit = {
        id: 5002, def: unitDef('knight'), hp: 60,
        x: farm.origin.col + 2.4, z: farm.origin.row + 1.2,
        home: null, cooldown: 0, specialIn: 0, stun: 0, dead: false, deadFor: 0, knockX: 0, knockZ: 0,
      };
      combat.units.push(shade, knight);
      for (let i = 0; i < 40; i++) combat.update(0.1);
      return { knightHp: knight.hp, farmHp: farm.hp };
    };

    const normal = run('normal');
    expect(normal.knightHp).toBe(60); // 正常档：敌人眼里只有楼
    expect(normal.farmHp).toBeLessThan(200); // 而且它真的在拆（不是"谁都没打"的假绿）

    const hard = run('hard');
    expect(hard.knightHp).toBeLessThan(60); // 困难档：先射奶妈/远程那一套之外，骑士也挨得到
  });

  /**
   * 主城偏置从写死的 −2 变成档位表里的数，所以它必须"能改口"才算接上了：
   * 同一处敌人、同一张场，只有档位不同 —— 三档各断一次，谁也不能靠巧合绿。
   * 摆法算过：敌人离田庄 1.5 格、离议事厅 4.5 格，
   * 所以偏置 0 与 2 都选田庄（4.5−2=2.5 > 1.5），偏置 4 才翻盘（4.5−4=0.5 < 1.5）。
   */
  it('主城偏置是真判据：简单与正常档拆近的田庄，困难档绕过田庄直奔议事厅', () => {
    const run = (difficulty: Difficulty) => {
      const { world, combat } = arena(difficulty);
      const farm = build(world, 'farm', pos(4, 6));
      const hall = build(world, 'hall', pos(7, 6));
      const fc = cellToWorld(world.rallyOf(farm));
      const hc = cellToWorld(world.rallyOf(hall));
      const raider: Unit = {
        id: 6001, def: unitDef('raider'), hp: 40,
        x: fc.x - 1.5, z: fc.z,
        home: null, cooldown: 0, specialIn: 0, stun: 0, dead: false, deadFor: 0, knockX: 0, knockZ: 0,
      };
      combat.units.push(raider);
      // 夹具自证：两段距离真是 1.5 与 4.5，否则"偏置翻盘"这件事根本没被测到
      expect(Math.hypot(fc.x - raider.x, fc.z - raider.z)).toBeCloseTo(1.5, 6);
      expect(Math.hypot(hc.x - raider.x, hc.z - raider.z)).toBeCloseTo(4.5, 6);

      for (let i = 0; i < 200; i++) combat.update(0.1);
      return { farmHp: farm.hp, hallHp: hall.hp };
    };

    for (const d of ['easy', 'normal'] as Difficulty[]) {
      const r = run(d);
      expect(r.farmHp).toBeLessThan(200); // 谁近拆谁
      expect(r.hallHp).toBe(600); // 议事厅一根毛没掉
    }
    const hard = run('hard');
    expect(hard.hallHp).toBeLessThan(600); // 偏置 4 格：宁远也要打心脏
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
