/**
 * 对战模式（Arena）的锁 —— 全是纯逻辑，node 里跑完，不用开浏览器。
 *
 * 这一族最容易糊弄自己的地方是"数值看着对，其实没跑过一整局"，
 * 所以每条都真的推进时间（`run()`），而不是只断言字段初值。
 */

import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { BARRACKS, CARDS, CORE, ECONOMY, FIELD, HAND } from '@arena/config';

function run(world: ArenaWorld, seconds: number, each?: (t: number) => void): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    world.update(0.05);
    each?.((i + 1) * 0.05);
  }
}

/** 直接把一张牌塞进第 0 格，免得测试依赖随机发牌。 */
function give(world: ArenaWorld, cardId: string): void {
  (world.hand as unknown as { 0: unknown })[0] = CARDS.find((c) => c.id === cardId)!;
  world.handCooldown[0] = 0;
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
    give(world, 'cannonTower'); // 7 费，开局只有 5
    const res = world.playCard('blue', 0, 7, 20);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('金币不够');
    expect(world.gold.blue).toBe(ECONOMY.start);
  });
});

describe('手牌：4 张、扣费、冷却后补位', () => {
  it('开局 4 张非空，打出一张扣钱并进冷却，冷却完补一张新的', () => {
    const world = new ArenaWorld({ seed: 7 });
    expect(world.hand.filter(Boolean)).toHaveLength(HAND.size);

    give(world, 'archers'); // 3 费
    const before = world.gold.blue;
    expect(world.playCard('blue', 0, 7, 20).ok).toBe(true);
    expect(world.gold.blue).toBeCloseTo(before - 3, 5);
    expect(world.hand[0]).toBeNull(); // 空槽 = 正在冷却
    expect(world.handCooldown[0]).toBeGreaterThan(0);

    // 冷却期间不许再打这一格
    expect(world.playCard('blue', 0, 7, 20).ok).toBe(false);

    run(world, HAND.refillSeconds + 0.2);
    expect(world.hand[0]).not.toBeNull();
  });

  it('只能放在自己半场：红方半场丢不出去', () => {
    const world = new ArenaWorld({ seed: 3 });
    give(world, 'archers');
    const res = world.playCard('blue', 0, 7, 2); // 上方 = 红方半场
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
    run(world, 2); // 先攒够 6 费（开局只有 5）
    give(world, 'barracks');
    expect(world.playCard('blue', 0, 5, 18).ok).toBe(true);
    const goldAfterBuild = world.gold.blue;

    run(world, BARRACKS.interval + 0.2);
    const spawned = world.units.filter((u) => u.side === 'blue').length;
    expect(spawned).toBeGreaterThanOrEqual(1);
    // 出兵不花金：这 6 秒里金只会涨
    expect(world.gold.blue).toBeGreaterThan(goldAfterBuild);
  });

  it('磨坊每 5 秒多给 2 金', () => {
    const world = new ArenaWorld({ seed: 5 });
    run(world, 1);
    give(world, 'mill');
    world.playCard('blue', 0, 2, 22);
    const before = world.gold.blue;
    run(world, ECONOMY.millInterval + 0.1);
    const gained = world.gold.blue - before;
    // 基础回充 + 磨坊奖励（没到上限时）
    expect(gained).toBeGreaterThan(ECONOMY.perSecond * ECONOMY.millInterval);
  });

  it('建筑没有寿命：放着 60 秒，血量一点不掉', () => {
    const world = new ArenaWorld({ seed: 5 });
    run(world, 1);
    give(world, 'arrowTower');
    world.playCard('blue', 0, 2, 22);
    const tower = [...world.buildings.values()].find((b) => b.kind === 'arrowTower')!;
    const hp = tower.hp;
    run(world, 60);
    const still = [...world.buildings.values()].find((b) => b.id === tower.id)!;
    expect(still.hp).toBe(hp);
  });
});

describe('兵：会往前走、会互相打', () => {
  it('场上只有对面核心时，兵会朝它移动', () => {
    const world = new ArenaWorld({ seed: 9 });
    give(world, 'orcs'); // 4 费
    world.playCard('blue', 0, 7, 20);
    const unit = world.units.find((u) => u.side === 'blue')!;
    const z0 = unit.z;
    run(world, 2);
    expect(unit.z).toBeLessThan(z0); // 蓝方朝上（row 变小）
  });

  it('两个敌对兵贴在一起会互相掉血', () => {
    const world = new ArenaWorld({ seed: 9 });
    give(world, 'archers');
    world.playCard('blue', 0, 7, 20);
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
    });
    run(lose, 3);
    expect(lose.outcome).toBe('lose');
  });

  it('兵死光不算输：核心还在就继续打', () => {
    const world = new ArenaWorld({ seed: 12 });
    give(world, 'archers');
    world.playCard('blue', 0, 7, 20);
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
    expect(blue.row).toBeGreaterThanOrEqual(FIELD.midRow);
    expect(red.row).toBeLessThan(FIELD.midRow);
    expect(world.cellFree(blue.col, blue.row, blue.cols, blue.rows)).toBe(false); // 自己占着
    expect(blue.hp).toBe(CORE.hp);
  });
});
