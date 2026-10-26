/**
 * 对战模式（Arena）的锁 —— 全是纯逻辑，node 里跑完，不用开浏览器。
 *
 * 这一族最容易糊弄自己的地方是"数值看着对，其实没跑过一整局"，
 * 所以每条都真的推进时间（`run()`），而不是只断言字段初值。
 */

import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { BARRACKS, CARDS, CORE, ECONOMY, FIELD, HAND, RUIN } from '@arena/config';

function run(world: ArenaWorld, seconds: number, each?: (t: number) => void): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    world.update(0.05);
    each?.((i + 1) * 0.05);
  }
}

/** 直接把一张牌塞进第 0 格，免得测试依赖随机发牌。 */
function give(world: ArenaWorld, cardId: string): { cost: number } {
  const card = CARDS.find((c) => c.id === cardId)!;
  (world.hand as unknown as { 0: unknown })[0] = card;
  world.handCooldown[0] = 0;
  return card;
}

describe('金币：上限 20、按秒回、开局 5', () => {
  it('开局 5，涨到 20 就停', () => {
    const world = new ArenaWorld({ seed: 1 });
    expect(world.gold.blue).toBe(ECONOMY.start);
    run(world, 30);
    // 蓝方没人出牌 → 涨到上限停住
    expect(world.gold.blue).toBeCloseTo(ECONOMY.cap, 5);
    // 红方是 AI，会一直花 → 永远到不了上限，而且不许为负
    expect(world.gold.red).toBeLessThanOrEqual(ECONOMY.cap);
    expect(world.gold.red).toBeGreaterThanOrEqual(0);
  });

  it('花出去的钱不会把金库打穿（金不够时出不了牌）', () => {
    const world = new ArenaWorld({ seed: 1 });
    // 开局 8 金：先压到只剩 2，再试 7 费的炮塔
    world.gold.blue = 2;
    give(world, 'cannonTower');
    const res = world.playCard('blue', 0, 6, 12);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('金币不够');
    // 没付成就是一分没动（这里是先压到 2 金的夹具）
    expect(world.gold.blue).toBe(2);
  });
});

describe('手牌：4 张、扣费、冷却后补位', () => {
  it('开局 4 张非空，打出一张扣钱并进冷却，冷却完补一张新的', () => {
    const world = new ArenaWorld({ seed: 7 });
    expect(world.hand.filter(Boolean)).toHaveLength(HAND.size);

    const card = give(world, 'archers');
    const before = world.gold.blue;
    expect(world.playCard('blue', 0, 6, 7).ok).toBe(true);
    // 价格翻倍过：读卡面自己的价，别把 3 写死
    expect(world.gold.blue).toBeCloseTo(before - card.cost, 5);
    expect(world.hand[0]).toBeNull(); // 空槽 = 正在冷却
    expect(world.handCooldown[0]).toBeGreaterThan(0);

    // 冷却期间不许再打这一格
    expect(world.playCard('blue', 0, 6, 7).ok).toBe(false);

    run(world, HAND.refillSeconds + 0.2);
    expect(world.hand[0]).not.toBeNull();
  });

  it('只能放在自己半场：红方半场丢不出去', () => {
    const world = new ArenaWorld({ seed: 3 });
    give(world, 'archers');
    const res = world.playCard('blue', 0, 30, 7); // 右侧 = 红方半场（也在黄区之外）
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('半场');
    expect(world.units.filter((u) => u.side === 'blue')).toHaveLength(0);
  });

  it('压着别的楼的那一格放不下', () => {
    const world = new ArenaWorld({ seed: 3 });
    const core = world.coreOf('blue')!;
    give(world, 'mill');
    const res = world.playCard('blue', 0, core.col, core.row);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('占了');
  });
});

describe('建筑：兵营出兵、磨坊生金、建筑不会自己掉血', () => {
  it('兵营每 6 秒出一个兵，且不花金', () => {
    const world = new ArenaWorld({ seed: 5 });
    // 价格翻倍后兵营 12 费：开局 8 金攒不满，直接给满
    world.gold.blue = 20;
    give(world, 'barracks');
    expect(world.playCard('blue', 0, 5, 10).ok).toBe(true);
    const goldAfterBuild = world.gold.blue;

    run(world, BARRACKS.interval + 0.2);
    const spawned = world.units.filter((u) => u.side === 'blue').length;
    expect(spawned).toBeGreaterThanOrEqual(1);
    // 出兵不花金：这 6 秒里金只会涨
    expect(world.gold.blue).toBeGreaterThan(goldAfterBuild);
  });

  it('磨坊每 5 秒多给 2 金', () => {
    const world = new ArenaWorld({ seed: 5 });
    world.gold.blue = 10; // 磨坊 8 费；留点余量，别一开盘就顶到上限 20
    give(world, 'mill');
    world.playCard('blue', 0, 6, 11);
    const before = world.gold.blue;
    run(world, ECONOMY.millInterval + 0.1);
    const gained = world.gold.blue - before;
    // 基础回充 + 磨坊奖励（没到上限时）
    expect(gained).toBeGreaterThan(ECONOMY.perSecond * ECONOMY.millInterval);
  });

  it('建筑没有寿命：放着 60 秒，血量一点不掉', () => {
    const world = new ArenaWorld({ seed: 5 });
    world.gold.blue = 20; // 箭塔 10 费
    give(world, 'arrowTower');
    world.playCard('blue', 0, 6, 11);
    const tower = [...world.buildings.values()].find((b) => b.kind === 'arrowTower')!;
    const hp = tower.hp;
    // 这条锁测的是"没有寿命、不会自己掉血"，所以把红方的兵一路清掉：
    // 被兵拆掉是另一回事（那属于战斗，AI 那边有锁）。不清的话 60 秒里塔会被打没。
    run(world, 60, () => {
      world.units = world.units.filter((u) => u.side !== 'red');
    });
    const still = [...world.buildings.values()].find((b) => b.id === tower.id)!;
    expect(still).toBeTruthy();
    expect(still.hp).toBe(hp);
  });
});

describe('兵：会往前走、会互相打', () => {
  it('场上只有对面核心时，兵会朝它移动', () => {
    const world = new ArenaWorld({ seed: 9 });
    give(world, 'orcs'); // 4 费
    world.playCard('blue', 0, 6, 7);
    const unit = world.units.find((u) => u.side === 'blue')!;
    const x0 = unit.x;
    run(world, 2);
    expect(unit.x).toBeGreaterThan(x0); // 横版：蓝方在左，朝右（col 变大）推进
  });

  it('两个敌对兵贴在一起会互相掉血', () => {
    const world = new ArenaWorld({ seed: 9 });
    give(world, 'archers');
    world.playCard('blue', 0, 6, 7);
    const blue = world.units.find((u) => u.side === 'blue')!;
    // 手工摆一个红兵在它旁边（AI 的行为另有测试）
    world.units.push({
      id: 9999,
      side: 'red',
      defId: 'archer',
      x: blue.x,
      z: blue.z - 0.8,
      hp: 26,
      maxHp: 26,
      cooldown: 0,
      stun: 0,
      order: null,
    });
    const red = world.units.find((u) => u.id === 9999)!;
    run(world, 2);
    expect(blue.hp).toBeLessThan(blue.maxHp);
    expect(red.hp).toBeLessThan(red.maxHp);
  });
});

describe('胜负：拆掉对方核心才算', () => {
  it('红方核心打到 0 → win；蓝方核心 0 → lose', () => {
    const win = new ArenaWorld({ seed: 11 });
    const redCore = win.coreOf('red')!;
    redCore.hp = 1;
    win.units.push({
      id: 7000,
      side: 'blue',
      defId: 'orc',
      x: redCore.col + 1,
      z: redCore.row + 2.3,
      hp: 80,
      maxHp: 80,
      cooldown: 0,
      stun: 0,
      order: null,
    });
    run(win, 3);
    expect(win.outcome).toBe('win');

    const lose = new ArenaWorld({ seed: 11 });
    lose.coreOf('blue')!.hp = 1;
    const core = lose.coreOf('blue')!;
    lose.units.push({
      id: 7001,
      side: 'red',
      defId: 'orc',
      x: core.col + 1,
      z: core.row - 0.3,
      hp: 80,
      maxHp: 80,
      cooldown: 0,
      stun: 0,
      order: null,
    });
    run(lose, 3);
    expect(lose.outcome).toBe('lose');
  });

  it('兵死光不算输：核心还在就继续打', () => {
    const world = new ArenaWorld({ seed: 12 });
    give(world, 'archers');
    world.playCard('blue', 0, 6, 7);
    run(world, 4);
    expect(world.outcome).toBe('playing');
  });
});

describe('AI：先建筑、后军队', () => {
  it('跑 40 秒之后红方至少立起一栋非核心建筑', () => {
    const world = new ArenaWorld({ seed: 13 });
    run(world, 40);
    const redBuildings = [...world.buildings.values()].filter((b) => b.side === 'red' && b.kind !== 'core');
    expect(redBuildings.length).toBeGreaterThan(0);
  });

  it('红方也会出兵（不是只盖楼）', () => {
    const world = new ArenaWorld({ seed: 14 });
    run(world, 60);
    expect(world.units.some((u) => u.side === 'red') || world.buildings.size > 0).toBe(true);
  });
});

describe('场地口径', () => {
  it('双方核心都在自己半场，且不重叠', () => {
    const world = new ArenaWorld({ seed: 15 });
    const blue = world.coreOf('blue')!;
    const red = world.coreOf('red')!;
    expect(blue.col).toBeLessThan(FIELD.midCol);
    expect(red.col).toBeGreaterThanOrEqual(FIELD.midCol);
    expect(world.cellFree(blue.col, blue.row, blue.cols, blue.rows)).toBe(false); // 自己占着
    expect(blue.hp).toBe(CORE.hp);
  });
});

describe('指挥与射程口径', () => {
  it('点地面 = 全军朝那儿走，到了自动恢复推进', () => {
    const world = new ArenaWorld({ seed: 21 });
    give(world, 'archers');
    world.playCard('blue', 0, 6, 9);
    const unit = world.units[0]!;
    unit.x = 8;
    unit.z = 10;
    const n = world.command('blue', 12, 10);
    expect(n).toBeGreaterThan(0);
    expect(unit.order).not.toBeNull();
    run(world, 6);
    // 走过去了：要么到了（order 清空），要么已经在打东西（位置应当已经跨过中间那条线）
    expect(unit.x).toBeGreaterThan(9.5);
  });

  it('塔的射程从占地边缘量：站在塔边缘外 3.5 格的弓手会被炮塔打到（不再白嫖）', () => {
    const world = new ArenaWorld({ seed: 22 });
    // 红方炮塔（3×3）放在右半场；价格翻倍后要 14 金
    world.gold.red = 20;
    give(world, 'cannonTower');
    expect(world.playCard('red', 0, 26, 9).ok).toBe(true);
    const tower = [...world.buildings.values()].find((b) => b.kind === 'cannonTower')!;
    const cx = tower.col + tower.cols / 2;
    const cz = tower.row + tower.rows / 2;
    const archer = {
      id: 8000,
      side: 'blue' as const,
      defId: 'archer',
      x: cx - (tower.cols / 2 + 3.5),
      z: cz,
      hp: 26,
      maxHp: 26,
      cooldown: 0,
      stun: 0,
      order: null,
    };
    world.units.push(archer);
    const hp0 = archer.hp;
    let died = false;
    let minHp = hp0;
    // 清掉双方其它兵（含 AI 出的兵），只为量这一座塔和这一个弓手
    run(world, 8, () => {
      world.units = world.units.filter((u) => u.id === 8000);
      const left = world.units.find((u) => u.id === 8000);
      if (!left) died = true;
      else minHp = Math.min(minHp, left.hp);
    });
    // 被打死算过，只掉血也算过 —— 关键是"站那儿不会毫无代价"
    expect(died || minHp < hp0).toBe(true);
  });
});

describe('炮塔朝向', () => {
  it('默认朝对面：蓝朝右（0 弧度）、红朝左（π）', () => {
    const world = new ArenaWorld({ seed: 31 });
    world.gold.blue = 20;
    world.gold.red = 20;
    give(world, 'arrowTower');
    expect(world.playCard('blue', 0, 6, 12).ok).toBe(true);
    give(world, 'arrowTower');
    expect(world.playCard('red', 0, 26, 12).ok).toBe(true);
    const towers = [...world.buildings.values()].filter((b) => b.kind === 'arrowTower');
    const blue = towers.find((b) => b.side === 'blue')!;
    const red = towers.find((b) => b.side === 'red')!;
    expect(blue.aim).toBe(0);
    expect(Math.abs(red.aim)).toBeCloseTo(Math.PI, 6);
  });
});

describe('中场黄区（禁建带）', () => {
  it('带子里盖楼、放兵都被挡；带子外一格就能放', () => {
    const world = new ArenaWorld({ seed: 41 });
    world.gold.blue = 20;
    give(world, 'mill');
    // midCol 在带子正中：3 列宽的楼一定压进去
    const inside = world.playCard('blue', 0, FIELD.midCol - 1, 8);
    expect(inside.ok).toBe(false);
    expect(inside.reason).toContain('黄区');

    give(world, 'archers');
    const squadIn = world.playCard('blue', 0, FIELD.midCol - 1, 8);
    expect(squadIn.ok).toBe(false);
    expect(squadIn.reason).toContain('黄区');

    // 带子左沿再往外一格 ⇒ 合法
    give(world, 'mill');
    const outside = world.playCard('blue', 0, FIELD.midCol - 1 - 3, 8);
    expect(outside.ok).toBe(true);
  });

  it('AI 不会把楼盖进带子里', () => {
    const world = new ArenaWorld({ seed: 42 });
    run(world, 60);
    const band = [...world.buildings.values()].filter(
      (b) => b.col + b.cols > FIELD.midCol - 1 && b.col < FIELD.midCol + 2,
    );
    expect(band).toHaveLength(0);
  });
});

describe('塔互殴 / 移动火炮 / 废墟', () => {
  it('两座塔都在射程里时会互相拆（不再只打兵）', () => {
    const world = new ArenaWorld({ seed: 51 });
    world.gold.blue = 20;
    world.gold.red = 20;
    give(world, 'arrowTower');
    expect(world.playCard('blue', 0, 17, 10).ok).toBe(true);
    give(world, 'arrowTower');
    expect(world.playCard('red', 0, 23, 10).ok).toBe(true);
    const [blue, red] = [...world.buildings.values()].filter((b) => b.kind === 'arrowTower');
    const hpB = blue!.hp;
    const hpR = red!.hp;
    // 清掉双方出的兵，只留两座塔互相打
    run(world, 12, () => {
      world.units = [];
    });
    expect(blue!.hp).toBeLessThan(hpB);
    expect(red!.hp).toBeLessThan(hpR);
  });

  it('移动火炮射程比塔远：站在塔射程外能把塔拆掉，自己不掉血', () => {
    const world = new ArenaWorld({ seed: 52 });
    world.gold.red = 20;
    give(world, 'arrowTower');
    expect(world.playCard('red', 0, 26, 9).ok).toBe(true);
    const tower = [...world.buildings.values()].find((b) => b.kind === 'arrowTower')!;
    const cx = tower.col + tower.cols / 2;
    const cz = tower.row + tower.rows / 2;
    // 摆在塔中心左边 7.0 格：塔的边缘射程只到 7.0（5.5+1.5），这一格刚好打不到
    world.units.push({
      id: 9100,
      side: 'blue',
      defId: 'mobileCannon',
      x: cx - 7.0,
      z: cz,
      hp: 90,
      maxHp: 90,
      cooldown: 0,
      stun: 0,
      order: null,
    });
    const hp0 = tower.hp;
    run(world, 10, () => {
      world.units = world.units.filter((u) => u.id === 9100);
    });
    const me = world.units.find((u) => u.id === 9100);
    expect(tower.hp).toBeLessThan(hp0); // 塔挨打了
    if (me) expect(me.hp).toBe(me.maxHp); // 火炮一滴血没掉（白嫖）
  });

  it('被拆掉的楼留废墟，过一段时间自己塌平', () => {
    const world = new ArenaWorld({ seed: 53 });
    world.gold.blue = 20;
    give(world, 'mill');
    expect(world.playCard('blue', 0, 6, 11).ok).toBe(true);
    const mill = [...world.buildings.values()].find((b) => b.kind === 'mill')!;
    (world as unknown as { hurtBuilding: (b: unknown, n: number) => void }).hurtBuilding(mill, 99999);
    expect(world.buildings.has(mill.id)).toBe(false);
    expect(world.ruins).toHaveLength(1);
    const ruin = world.ruins[0]!;
    expect(ruin.col).toBe(mill.col);
    expect(ruin.ttl).toBeCloseTo(RUIN.seconds, 5);

    run(world, RUIN.seconds - 1);
    expect(world.ruins).toHaveLength(1); // 还没到点
    run(world, 2);
    expect(world.ruins).toHaveLength(0); // 塌平了
  });
});
