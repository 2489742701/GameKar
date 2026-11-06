/**
 * 对战模式（Arena）的锁 —— 全是纯逻辑，node 里跑完，不用开浏览器。
 *
 * 这一族最容易糊弄自己的地方是"数值看着对，其实没跑过一整局"，
 * 所以每条都真的推进时间（`run()`），而不是只断言字段初值。
 */

import { describe, expect, it } from 'vitest';
import { ArenaWorld, type ArenaUnit } from '@arena/ArenaWorld';
import { chooseCard, wishList } from '@arena/ai';
import { BARRACKS, BUILD, CARDS, CORE, ECONOMY, FIELD, HAND, MATCH, NO_BUILD, REROLL, RUIN, SUPPLY, UNIT, cardById } from '@arena/config';

function run(world: ArenaWorld, seconds: number, each?: (t: number) => void): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    world.update(0.05);
    each?.((i + 1) * 0.05);
  }
}

/**
 * 测试专用：直接落一栋楼并**跳过施工**。
 *
 * `b.build` 是 2026-11-02 加的玩法（楼要垒几秒才干活，见 config.BUILD）。
 * 这一族锁测的是"落位之后"的规则（后勤、射程、塔互殴），先空跑 3–4 秒只会让每条锁变慢；
 * **施工本身另有专门的锁**（见「建筑要盖几秒」那一组）。
 */
function instant(
  world: ArenaWorld,
  side: 'blue' | 'red',
  kind: 'barracks' | 'arrowTower' | 'cannonTower' | 'mill' | 'house' | 'core',
  col: number,
  row: number,
  hp: number,
) {
  const b = world['place'](side, kind, col, row, hp);
  b.build = 1;
  return b;
}

/**
 * 直接把一张牌塞进第 0 格，免得测试依赖随机发牌。
 *
 * `side` 是必须的：红方现在也有自己的一副手牌（`world.hands.red`），
 * 出牌读的是**自己那一副**。以前两边共用蓝方那副，测试就靠"塞给蓝方、让红方出"蒙混过关 ——
 * 那是旧实现的巧合，不是设计。
 */
function give(world: ArenaWorld, cardId: string, side: 'blue' | 'red' = 'blue'): { cost: number } {
  const card = CARDS.find((c) => c.id === cardId)!;
  world.hands[side][0] = card;
  world.handCooldowns[side][0] = 0;
  return card;
}

describe('金币：上限 20、按秒回、开局 8', () => {
  it('开局 8，涨到 20 就停（2.5 秒一格 ⇒ 55 秒足够从 8 走到 20）', () => {
    const world = new ArenaWorld({ seed: 1 });
    expect(world.gold.blue).toBe(ECONOMY.start);
    run(world, 55);
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
    world.gold.blue = 20; // 磨坊 2026-11-06 涨到 10 金，开局 8 金不够了 —— 这条锁的是占位判定，不是钱
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
    // 2026-10-27 新规则：兵营要配 1 磨坊 + 1 民居才会出兵
    instant(world, 'blue', 'mill', 10, 10, 300);
    instant(world, 'blue', 'house', 10, 5, 220);
    const goldAfterBuild = world.gold.blue;

    // 兵营是 playCard 落下去的 ⇒ 要先垒完（BUILD.seconds.barracks）才开始计时
    run(world, BUILD.seconds.barracks + BARRACKS.interval + 0.3);
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
    // 先把磨坊垒完（施工期间不生金），再从头数 5 秒
    run(world, BUILD.seconds.mill + 0.1);
    const before = world.gold.blue;
    run(world, ECONOMY.millInterval + 0.1);
    const gained = world.gold.blue - before;
    // 5.1 秒里金币按 2 秒一格跳 2 格（+2），磨坊再补 +2 ⇒ 至少 4
    expect(gained).toBeGreaterThanOrEqual(ECONOMY.millBonus + 2);
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
  it('场上只有对面大本营时，兵会朝它移动', () => {
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
    // 2026-11-06 水晶攻击后：交火点必须离主城远一点（水晶射程 5.5+1.5 从占地边缘量），
    // 否则水晶一箭把红兵秒了、测试量的是水晶不是互殴
    world.playCard('blue', 0, 12, 7);
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
      order: null, detour: 1 as const,
    });
    const red = world.units.find((u) => u.id === 9999)!;
    run(world, 2);
    expect(blue.hp).toBeLessThan(blue.maxHp);
    expect(red.hp).toBeLessThan(red.maxHp);
  });
});

describe('胜负：拆掉对方大本营才算', () => {
  it('红方大本营打到 0 → win；蓝方大本营 0 → lose', () => {
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
      order: null, detour: 1 as const,
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
      order: null, detour: 1 as const,
    });
    run(lose, 3);
    expect(lose.outcome).toBe('lose');
  });

  it('兵死光不算输：大本营还在就继续打', () => {
    const world = new ArenaWorld({ seed: 12 });
    give(world, 'archers');
    world.playCard('blue', 0, 6, 7);
    run(world, 4);
    expect(world.outcome).toBe('playing');
  });
});

describe('AI：先建筑、后军队', () => {
  it('跑 40 秒之后红方至少立起一栋非大本营建筑', () => {
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
  it('双方大本营都在自己半场，且不重叠', () => {
    const world = new ArenaWorld({ seed: 15 });
    const blue = world.coreOf('blue')!;
    const red = world.coreOf('red')!;
    expect(blue.col).toBeLessThan(FIELD.midCol);
    expect(red.col).toBeGreaterThanOrEqual(FIELD.midCol);
    expect(world.cellFree(blue.col, blue.row, blue.cols, blue.rows)).toBe(false); // 自己占着
    expect(blue.hp).toBe(CORE.hp);
  });
});

/**
 * 2026-11-07：玩家点地面指挥已关（军队是棋子），这里测的是**内部 API**
 * `world.command()` —— 留给 PVE 波次脚本用；玩家入口由实机探针验收。
 */
describe('内部指挥 API 与射程口径', () => {
  it('内部 command：全军朝那儿走，到了自动恢复推进', () => {
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
    world.auto.red = false;
    // 2026-11-06 改确定性摆法：以前走 playCard + AI 配齐民居的时序，价格一调就翻车 ——
    // 这条锁的是**射程口径**，不是发牌。instant 落塔 + 民居，塔随时都能开火。
    const tower = instant(world, 'red', 'cannonTower', 28, 9, 640);
    instant(world, 'red', 'house', 36, 9, 220);
    expect(world.isStaffed(tower.id)).toBe(true);
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
      order: null, detour: 1 as const,
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
    give(world, 'arrowTower', 'red');
    expect(world.playCard('red', 0, 28, 12).ok).toBe(true);
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
    // midCol 在带子正中：3 列宽的楼放在带子最左一列，一定压进去
    const inside = world.playCard('blue', 0, FIELD.midCol - NO_BUILD.halfWidth, 8);
    expect(inside.ok).toBe(false);
    expect(inside.reason).toContain('黄区');

    give(world, 'archers');
    const squadIn = world.playCard('blue', 0, FIELD.midCol - NO_BUILD.halfWidth, 8);
    expect(squadIn.ok).toBe(false);
    expect(squadIn.reason).toContain('黄区');

    // 带子左沿再往外一格 ⇒ 合法
    give(world, 'mill');
    const outside = world.playCard('blue', 0, FIELD.midCol - NO_BUILD.halfWidth - 3, 8);
    expect(outside.ok).toBe(true);
  });

  it('AI 不会把楼盖进带子里', () => {
    const world = new ArenaWorld({ seed: 42 });
    run(world, 60);
    const band = [...world.buildings.values()].filter(
      (b) => b.col + b.cols > FIELD.midCol - NO_BUILD.halfWidth && b.col < FIELD.midCol + NO_BUILD.halfWidth + 1,
    );
    expect(band).toHaveLength(0);
  });
});

describe('塔互殴 / 移动火炮 / 废墟', () => {
  /**
   * 塔会打进入射程的敌方建筑。
   *
   * 2026-11-02 起这条**不能再用"两座塔隔中场互殴"来测**：禁建带从 5 列加宽到 7 列之后，
   * 两边最近的合法落点相距 10 格，而箭塔边缘射程只有 6.8 —— 跨中线互殴在实战里已经打不到了。
   * 所以这里用 `instant` 把红方兵营直接摆进蓝塔射程（place 不查半场，只造场景），
   * 验的还是同一条逻辑："塔的靶子里不只有兵，还有楼"。
   */
  it('塔会打进入射程的敌方建筑（不再只打兵）', () => {
    const world = new ArenaWorld({ seed: 51 });
    world.auto.red = false;
    instant(world, 'blue', 'house', 9, 10, 220);
    instant(world, 'blue', 'arrowTower', 14, 10, 520);
    const target = instant(world, 'red', 'barracks', 19, 10, 420);
    const hp0 = target.hp;
    run(world, 4);
    expect(target.hp).toBeLessThan(hp0);
  });

  it('移动火炮射程比塔远：站在塔射程外能把塔拆掉，自己不掉血', () => {
    const world = new ArenaWorld({ seed: 52 });
    world.gold.red = 20;
    give(world, 'arrowTower', 'red');
    expect(world.playCard('red', 0, 28, 9).ok).toBe(true);
    const tower = [...world.buildings.values()].find((b) => b.kind === 'arrowTower')!;
    const cx = tower.col + tower.cols / 2;
    const cz = tower.row + tower.rows / 2;
    // 摆在塔中心左边 8.6 格：塔的边缘射程 = 6.8（range）+ 1.5（半占地）= 8.3，够不着；
    // 火炮的 = 7.2 + 1.5 = 8.7，够得着 —— 中间这 0.4 格就是"白嫖"的窗口
    world.units.push({
      id: 9100,
      side: 'blue',
      defId: 'mobileCannon',
      x: cx - 8.6,
      z: cz,
      hp: 90,
      maxHp: 90,
      cooldown: 0,
      stun: 0,
      order: null, detour: 1 as const,
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

describe('兵不穿楼', () => {
  it('同阵营的楼挡在直线上时会绕开，任何一帧都不会站在楼的占地里', () => {
    const world = new ArenaWorld({ seed: 61 });
    world.gold.blue = 20;
    give(world, 'mill');
    expect(world.playCard('blue', 0, 12, 9).ok).toBe(true);
    // 蓝兵从磨坊西边出发往东打红方大本营：那栋磨坊是**自己人**的，不是目标，
    // 但直线正好从它中间穿过 —— 走得进去就说明会穿模（变异打红的就是这一条）
    world.units.push({
      id: 9500,
      side: 'blue',
      defId: 'orc',
      x: 10.2,
      z: 10.5,
      hp: 80,
      maxHp: 80,
      cooldown: 0,
      stun: 0,
      order: null, detour: 1 as const,
    });
    const inside = (x: number, z: number): boolean => {
      const col = Math.floor(x);
      const row = Math.floor(z);
      for (const b of world.buildings.values()) {
        if (col >= b.col && col < b.col + b.cols && row >= b.row && row < b.row + b.rows) return true;
      }
      return false;
    };
    let violations = 0;
    run(world, 8, () => {
      const u = world.units.find((x) => x.id === 9500);
      if (u && inside(u.x, u.z)) violations++;
    });
    expect(violations).toBe(0);
  });
});

describe('金币节奏（2026-10-31 放慢到每 2 秒一个）', () => {
  it('严格按 2 秒跳 +1：1.9 秒还是 0，2.1 秒是 1，5.1 秒是 2', () => {
    const world = new ArenaWorld({ seed: 71 });
    world.gold.blue = 0;
    run(world, 1.9);
    expect(world.gold.blue).toBe(0);
    run(world, 0.2);
    expect(world.gold.blue).toBe(ECONOMY.perTick);
    run(world, 3);
    expect(world.gold.blue).toBe(ECONOMY.perTick * 2);
  });

  it('涨到上限 20 就停（不会溢出）', () => {
    const world = new ArenaWorld({ seed: 72 });
    world.gold.blue = ECONOMY.cap;
    run(world, 6);
    expect(world.gold.blue).toBe(ECONOMY.cap);
  });
});

describe('弹丸的出处（视图据此决定炮口高度/烟雾位置）', () => {
  it('塔开火带 source，移动火炮开火也会生成一发炮弹', () => {
    const world = new ArenaWorld({ seed: 91 });
    // 炮塔 vs 红方兵营：距离 5 格（炮塔射程 4.4 + 半占地 1.5 = 5.9，够得着）
    // 塔要一座民居才开火（2026-10-31），所以先给它配一个
    instant(world, 'blue', 'house', 17, 4, 220);
    instant(world, 'blue', 'cannonTower', 22, 4, 640);
    instant(world, 'red', 'barracks', 27, 4, 420);
    run(world, 0.3);
    const towerShot = world.shots.find((s) => s.source === 'cannonTower');
    expect(towerShot, '炮塔应当打出 source=cannonTower 的一发').toBeTruthy();
    expect(towerShot!.ammo).toBe('cannon');

    // 移动火炮：直接塞到红方大本营的射程边上。
    // 炮弹只活 0.5 秒，必须在推进过程里采（跑完再看就飞没了）
    world['spawnSquad']('blue', [{ unitId: 'mobileCannon', count: 1 }], 30, 10);
    let siegeSeen = false;
    let siegeAmmo = '';
    run(world, 1.2, () => {
      const hit = world.shots.find((s) => s.source === 'siege');
      if (hit) {
        siegeSeen = true;
        siegeAmmo = hit.ammo;
      }
    });
    expect(siegeSeen, '移动火炮应当打出 source=siege 的一发').toBe(true);
    expect(siegeAmmo).toBe('cannon');
  });
});

describe('寻路：撞到楼要绕过去（用户：撞到建筑然后不动了）', () => {
  it('友军的楼挡在必经之路上时，兵会绕过去继续推进', () => {
    const world = new ArenaWorld({ seed: 61 });
    // 友军磨坊挡在 (14..16, 9..11)：不是目标（友军），但正好在蓝兵 → 红方大本营的直线上
    instant(world, 'blue', 'mill', 14, 9, 300);
    world.units.push({
      id: 9600,
      side: 'blue',
      defId: 'knight',
      x: 10.5,
      z: 10.5,
      hp: 260,
      maxHp: 260,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    run(world, 12, () => {
      // 只留这一个兵，排掉双方自动出的兵/敌方干扰
      world.units = world.units.filter((u) => u.id === 9600);
    });
    const me = world.units.find((u) => u.id === 9600)!;
    expect(me.x, '应该绕过磨坊走到它右边').toBeGreaterThan(17);
  });

  it('移动火炮也会打兵（用户：为什么不攻击这个军队）', () => {
    const world = new ArenaWorld({ seed: 62 });
    world.units.push({
      id: 9700,
      side: 'red',
      defId: 'orc',
      x: 21,
      z: 10.5,
      hp: 260,
      maxHp: 260,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    world.units.push({
      id: 9701,
      side: 'blue',
      defId: 'mobileCannon',
      x: 16,
      z: 10.5,
      hp: 90,
      maxHp: 90,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    const orc = world.units[0]!;
    run(world, 5, () => {
      world.units = world.units.filter((u) => u.id === 9700 || u.id === 9701);
    });
    expect(orc.hp, '红方兽人应该被移动火炮打过').toBeLessThan(orc.maxHp);
  });
});

describe('新增兵种：法师的法术弹', () => {
  it('法师打人时会飞一发法术弹（source=unit, ammo=magic）', () => {
    const world = new ArenaWorld({ seed: 63 });
    world.units.push({
      id: 9800,
      side: 'red',
      defId: 'orc',
      x: 22,
      z: 10.5,
      hp: 80,
      maxHp: 80,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    world.units.push({
      id: 9801,
      side: 'blue',
      defId: 'mage',
      x: 19.5,
      z: 10.5,
      hp: 32,
      maxHp: 32,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    let seen = false;
    run(world, 1.2, () => {
      world.units = world.units.filter((u) => u.id === 9800 || u.id === 9801);
      if (world.shots.some((s) => s.source === 'unit' && s.ammo === 'magic')) seen = true;
    });
    expect(seen, '法师应当打出一发 source=unit / ammo=magic 的法术弹').toBe(true);
  });
});


describe('兵营后勤：1 座磨坊 + 1 座民居（用户 2026-10-27）', () => {
  it('没有后勤就不出兵', () => {
    const world = new ArenaWorld({ seed: 11 });
    instant(world, 'blue', 'barracks', 5, 10, 420);
    run(world, BARRACKS.interval * 2);
    expect(world.units.filter((u) => u.side === 'blue'), '没有磨坊/民居时不应该出兵').toHaveLength(0);
    expect(world.supportedBarracks('blue')).toBe(0);
  });

  it('只有磨坊或只有民居都不行', () => {
    const millOnly = new ArenaWorld({ seed: 12 });
    instant(millOnly, 'blue', 'barracks', 5, 10, 420);
    instant(millOnly, 'blue', 'mill', 10, 10, 300);
    run(millOnly, BARRACKS.interval + 0.3);
    expect(millOnly.units.filter((u) => u.side === 'blue')).toHaveLength(0);

    const houseOnly = new ArenaWorld({ seed: 13 });
    instant(houseOnly, 'blue', 'barracks', 5, 10, 420);
    instant(houseOnly, 'blue', 'house', 10, 10, 220);
    run(houseOnly, BARRACKS.interval + 0.3);
    expect(houseOnly.units.filter((u) => u.side === 'blue')).toHaveLength(0);
  });

  it('配齐一套后勤：两座兵营只有先盖的那座开工', () => {
    const world = new ArenaWorld({ seed: 14 });
    instant(world, 'blue', 'barracks', 3, 10, 420);
    instant(world, 'blue', 'barracks', 8, 10, 420);
    instant(world, 'blue', 'mill', 13, 10, 300);
    instant(world, 'blue', 'house', 13, 4, 220);
    const barracks = [...world.buildings.values()]
      .filter((b) => b.kind === 'barracks')
      .sort((a, b) => a.id - b.id);
    expect(world.supportedBarracks('blue')).toBe(1);
    expect(world.isStaffed(barracks[0]!.id)).toBe(true);
    expect(world.isStaffed(barracks[1]!.id)).toBe(false);

    run(world, BARRACKS.interval + 0.3);
    expect(world.units.filter((u) => u.side === 'blue'), '只应该有一座兵营出兵').toHaveLength(1);
  });

  it('再补一套后勤，第二座兵营也开工', () => {
    const world = new ArenaWorld({ seed: 15 });
    instant(world, 'blue', 'barracks', 3, 10, 420);
    instant(world, 'blue', 'barracks', 8, 10, 420);
    instant(world, 'blue', 'mill', 13, 10, 300);
    instant(world, 'blue', 'house', 13, 4, 220);
    expect(world.supportedBarracks('blue')).toBe(1);
    instant(world, 'blue', 'mill', 17, 10, 300);
    instant(world, 'blue', 'house', 17, 4, 220);
    expect(world.supportedBarracks('blue')).toBe(2);
  });
});

/**
 * 防御建筑也占一座民居（用户 2026-10-31）：
 * "必须要有一个磨坊提供食物，还有一处民房，防御建筑也占一处民房。
 *  要求是严格的，咱们是要拖他的建筑，去处理攻防。"
 *
 * 这几条锁的就是"拖建筑"这条设计：拆掉民居，塔就哑火 —— 而不是"塔拆了才算"。
 */
describe('防御建筑也占一座民居（2026-10-31）', () => {
  /** 在给定位置放一个红方骑士，当塔的靶子。 */
  function dummy(w: ArenaWorld, x: number, z: number): void {
    w.units.push({
      id: 9100,
      side: 'red',
      defId: 'knight',
      x,
      z,
      hp: 600,
      maxHp: 600,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1,
    });
  }

  /** 跑一段时间，看这座塔有没有真的打出过弹丸（弹丸只活 0.22 秒，必须逐帧收）。 */
  function everFired(w: ArenaWorld, seconds: number): boolean {
    let fired = false;
    run(w, seconds, () => {
      if (w.shots.some((s) => s.source === 'arrowTower')) fired = true;
    });
    return fired;
  }

  it('没有民居的塔不开火', () => {
    const w = new ArenaWorld({ seed: 31 });
    w.auto.red = false;
    instant(w, 'blue', 'arrowTower', 5, 10, 520);
    dummy(w, 6.5, 14);
    expect(everFired(w, 2)).toBe(false);
  });

  it('补一座民居，塔立刻开火（缺配时不动装填，补上不用等一个周期）', () => {
    const w = new ArenaWorld({ seed: 32 });
    w.auto.red = false;
    const tower = instant(w, 'blue', 'arrowTower', 5, 10, 520);
    dummy(w, 6.5, 14);
    instant(w, 'blue', 'house', 12, 10, 220);
    expect(w.isStaffed(tower.id)).toBe(true);
    expect(everFired(w, 2)).toBe(true);
  });

  it('一座民居只养一座塔：后盖的那座不算配齐', () => {
    const w = new ArenaWorld({ seed: 33 });
    w.auto.red = false;
    const first = instant(w, 'blue', 'arrowTower', 3, 10, 520);
    const second = instant(w, 'blue', 'arrowTower', 10, 10, 520);
    instant(w, 'blue', 'house', 15, 10, 220);
    expect(w.isStaffed(first.id)).toBe(true);
    expect(w.isStaffed(second.id)).toBe(false);
    expect(w.staffedCount('blue')).toBe(1);
    expect(w.needStaffing('blue')).toBe(2);
  });

  it('拆掉民居，那座塔立刻哑火 —— "拖他的建筑"就是这么生效的', () => {
    const w = new ArenaWorld({ seed: 34 });
    w.auto.red = false;
    const tower = instant(w, 'blue', 'arrowTower', 5, 10, 520);
    const house = instant(w, 'blue', 'house', 12, 10, 220);
    dummy(w, 6.5, 14);
    expect(everFired(w, 1.5), '有民居时应当开火').toBe(true);
    w.buildings.delete(house.id);
    expect(w.isStaffed(tower.id)).toBe(false);
    expect(everFired(w, 2), '民居被拆之后还在开火，那这套规则就是假的').toBe(false);
  });

  it('兵营要两样、塔只要民居：民居总量才是这一局的真上限', () => {
    const w = new ArenaWorld({ seed: 35 });
    w.auto.red = false;
    instant(w, 'blue', 'barracks', 3, 4, 420);
    instant(w, 'blue', 'arrowTower', 3, 14, 520);
    instant(w, 'blue', 'mill', 9, 4, 300);
    instant(w, 'blue', 'house', 9, 14, 220);
    // 1 磨坊 + 1 民居 = 只够一座兵营；塔排在后头（楼号大），缺配
    expect(w.staffedCount('blue')).toBe(1);
    expect(w.needStaffing('blue')).toBe(2);
    expect(w.supportedBarracks('blue')).toBe(1);
  });
});


describe('移动弩箭：只打兵，不拆楼（用户 2026-10-27）', () => {
  it('敌楼在射程内也不打；敌兵进射程就挨打', () => {
    const world = new ArenaWorld({ seed: 64 });
    // 红方大本营在 (38..40)；弩箭站到它射程边上：只打兵 ⇒ 大本营一滴血不掉
    world.units.push({
      id: 9900,
      side: 'blue',
      defId: 'ballista',
      x: 35,
      z: 10.5,
      hp: 70,
      maxHp: 70,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    const core = [...world.buildings.values()].find((b) => b.kind === 'core' && b.side === 'red')!;
    const hp0 = core.hp;
    run(world, 2.5, () => {
      world.units = world.units.filter((u) => u.id === 9900);
    });
    expect(core.hp, '弩箭不应该拆楼').toBe(hp0);

    // 放一个红兵到弩箭前方：它应该掉血
    world.units.push({
      id: 9901,
      side: 'red',
      defId: 'orc',
      x: 36,
      z: 14.5,
      hp: 80,
      maxHp: 80,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    let hurt = false;
    run(world, 3, () => {
      const orc = world.units.find((u) => u.id === 9901);
      if (orc && orc.hp < orc.maxHp) hurt = true;
    });
    expect(hurt, '弩箭应该点掉步兵').toBe(true);
  });

  it('弩箭的弹道是 source=ballista、ammo=arrow', () => {
    const world = new ArenaWorld({ seed: 65 });
    world.units.push({
      id: 9910,
      side: 'blue',
      defId: 'ballista',
      x: 20,
      z: 10.5,
      hp: 70,
      maxHp: 70,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    world.units.push({
      id: 9911,
      side: 'red',
      defId: 'orc',
      x: 24,
      z: 10.5,
      hp: 80,
      maxHp: 80,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1 as const,
    });
    let seen = false;
    run(world, 1.2, () => {
      world.units = world.units.filter((u) => u.id === 9910 || u.id === 9911);
      if (world.shots.some((s) => s.source === 'ballista' && s.ammo === 'arrow')) seen = true;
    });
    expect(seen).toBe(true);
  });
});

describe('牧师：周期回血（用户 2026-10-27："继续增加单位"）', () => {
  it('每 2.5 秒给身边 3 格内的自己人回 6 血，并放一个治疗事件', () => {
    const world = new ArenaWorld({ seed: 66 });
    world.units.push({
      id: 9930,
      side: 'blue',
      defId: 'priest',
      x: 10.5,
      z: 10.5,
      hp: 30,
      maxHp: 30,
      cooldown: 0,
      stun: 0,
      order: { x: 12, z: 10.5 },
      detour: 1 as const,
    });
    world.units.push({
      id: 9931,
      side: 'blue',
      defId: 'knight',
      x: 11.4,
      z: 10.5,
      hp: 20,
      maxHp: 60,
      cooldown: 0,
      stun: 0,
      order: { x: 12, z: 10.5 },
      detour: 1 as const,
    });
    let sawHealFx = false;
    run(world, 3.2, () => {
      world.units = world.units.filter((u) => u.id === 9930 || u.id === 9931);
      if (world.heals.length > 0) sawHealFx = true;
    });
    const knight = world.units.find((u) => u.id === 9931)!;
    expect(knight.hp, '骑士应该被奶了一口').toBeGreaterThan(20);
    expect(sawHealFx, '应该产生治疗视觉事件').toBe(true);
  });
});

/**
 * 我方托管（auto.blue）—— 用户 2026-10-27："自动化测试时，我方应该自动建建筑"。
 *
 * 为什么要有这一族：蓝方挂机时 60 秒就被推平（实测大本营 1200 → 0），
 * 那种"一局"测出来的是"没人操作会怎样"，不是这局游戏本身。
 * 托管打开之后两边都是 AI，一局能自己打完，平衡性才有得测。
 */
/**
 * 手牌去重 + 敌方 AI 会攒钱（用户 2026-10-28 两条）。
 *
 * 改之前的实测：40 局里 **17 局**手牌带重复（`orcs/cannonTower/house/house`）；
 * 红方 90 秒出了 9 张牌、**6 张是弓箭手** —— 因为它从不攒钱，
 * 想要的牌买不起就退而求其次买最便宜的，于是永远只买得起最便宜的那张。
 */
describe('手牌与敌方 AI', () => {
  it('开局 4 张互不相同（40 局采样，改之前 17 局带重复）', () => {
    for (let s = 1; s <= 40; s++) {
      const w = new ArenaWorld({ seed: s * 7919 });
      const ids = w.hand.map((c) => c?.id);
      expect(new Set(ids).size, '手牌里出现了重复的牌：' + ids.join('/')).toBe(ids.length);
    }
  });

  it('打出一张之后补进来的牌，也不会和手里剩下的三张撞车', () => {
    const world = new ArenaWorld({ seed: 3 });
    world.gold.blue = ECONOMY.cap;
    // 2026-11-05 起人口是**硬门槛**（开局 6 点、建筑占 2）：连打四张牌会撞到上限，
    // 而这条测的是补牌去重、不是人口，所以先补几座民居把地盘撑开
    for (let i = 0; i < 4; i++) instant(world, 'blue', 'house', 1 + i * 3, 17, 220);
    for (let slot = 0; slot < HAND.size; slot++) {
      const before = world.hand[slot]!.id;
      // 落在自己半场的一块空地上
      const cell = { col: 4 + slot * 3, row: 4 };
      expect(world.playCard('blue', slot, cell.col, cell.row).ok).toBe(true);
      run(world, HAND.refillSeconds + 0.3);
      const ids = world.hand.map((c) => c?.id);
      expect(new Set(ids).size, '补牌之后出现了重复：' + ids.join('/')).toBe(ids.length);
      expect(ids, '补进来的还是刚打出去那张').not.toContain(before);
      world.gold.blue = ECONOMY.cap;
    }
  });

  it('红方也有自己的一副手牌（两边受同样的限制），而且同样不重复', () => {
    const world = new ArenaWorld({ seed: 9 });
    expect(world.hands.red.filter(Boolean).length).toBe(HAND.size);
    const ids = world.hands.red.map((c) => c?.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('AI 会为建筑攒钱：60 秒内至少立起一座塔或兵营（不再一直出弓箭手）', () => {
    const world = new ArenaWorld({ seed: 20261027 });
    run(world, 60);
    const red = [...world.buildings.values()].filter((b) => b.side === 'red' && b.kind !== 'core');
    const kinds = red.map((b) => b.kind);
    const hasCoreBuilding = kinds.some((k) => k === 'arrowTower' || k === 'cannonTower' || k === 'barracks' || k === 'mill');
    expect(hasCoreBuilding, '红方 60 秒只出了这些：' + (kinds.join('/') || '什么都没立')).toBe(true);
  });

  it('军队分大小两档：大队人更多、也更贵', () => {
    const pairs: [string, string][] = [
      ['archers', 'archersBig'],
      ['knights', 'knightsBig'],
      ['orcs', 'orcsBig'],
    ];
    for (const [small, big] of pairs) {
      const a = CARDS.find((c) => c.id === small)!;
      const b = CARDS.find((c) => c.id === big)!;
      const men = (c: typeof a) => (c.squad ?? []).reduce((n, m) => n + m.count, 0);
      expect(men(b), `${big} 人数`).toBeGreaterThan(men(a));
      expect(b.cost, `${big} 价格`).toBeGreaterThan(a.cost);
      // 但人不翻倍、价也不翻倍：大队是"性价比更高但一次掏钱更集中"
      expect(b.cost).toBeLessThan(a.cost * 2);
    }
  });
});

describe('我方托管', () => {
  it('默认不托管，红方恒为托管（蓝方是玩家的位置）', () => {
    const world = new ArenaWorld({ seed: 1 });
    expect(world.auto.blue).toBe(false);
    expect(world.auto.red).toBe(true);
    // 红方不许关：它没有手牌，关掉就再也不动了
    world.setAuto('red', false);
    expect(world.auto.red).toBe(true);
  });

  it('托管之后蓝方真的会盖楼：60 秒内至少一栋非大本营建筑', () => {
    const world = new ArenaWorld({ seed: 11, auto: { blue: true } });
    run(world, 60);
    const mine = [...world.buildings.values()].filter((b) => b.side === 'blue' && b.kind !== 'core');
    expect(mine.length, '托管 60 秒一栋楼都没立起来').toBeGreaterThanOrEqual(1);
    // 而且落点在自己半场、不压中线
    for (const b of mine) {
      expect(b.col + b.cols).toBeLessThanOrEqual(FIELD.midCol - NO_BUILD.halfWidth);
    }
  });

  it('蓝方出的是**手牌里的牌**，不是从整池凭空挑（走玩家的出牌链路）', () => {
    const world = new ArenaWorld({ seed: 7, auto: { blue: true } });
    // 手上只留一张买得起的箭塔，其余三格空着 —— 能盖出来就说明它来自手牌
    world.hand[0] = cardById('arrowTower');
    world.hand[1] = null;
    world.hand[2] = null;
    world.hand[3] = null;
    world.gold.blue = ECONOMY.cap;
    // 2026-11-06 起 AI 会主动刷新：一座民居都没有时会花 5 金换牌（保底民居），
    // 把这里手工摆的塔换掉。先给它一座民居，测的才是「AI 只用手牌」这件事本身。
    instant(world, 'blue', 'house', 4, 15, 220);
    run(world, 8);
    const mine = [...world.buildings.values()].filter((b) => b.side === 'blue' && b.kind !== 'core');
    expect(mine.map((b) => b.kind)).toContain('arrowTower');
  });

  it('两边都托管时一局能自己打起来（不是各盖各的谁也不动）', () => {
    const world = new ArenaWorld({ seed: 20261027, auto: { blue: true } });
    let blueUnits = 0;
    let redUnits = 0;
    /**
     * 交火的判据是"**有单位掉过血**"，不是"大本营掉过血"。
     *
     * 我一开始写的是大本营必须掉血，结果红了 —— 诊断出来两边势均力敌时
     * 兵在中间互相消耗（实测蓝方推到 x=25.7、红方推到 x=7.1，都有掉血单位），
     * 大本营 1200 血谁也没摸到。那是**正常对局**，不是"没打起来"。
     * "势均力敌"不该被判成 bug。
     */
    let sawHurtUnit = false;
    run(world, 120, () => {
      blueUnits = Math.max(blueUnits, world.units.filter((u) => u.side === 'blue').length);
      redUnits = Math.max(redUnits, world.units.filter((u) => u.side === 'red').length);
      if (world.units.some((u) => u.hp < u.maxHp)) sawHurtUnit = true;
    });
    expect(blueUnits).toBeGreaterThan(0);
    expect(redUnits).toBeGreaterThan(0);
    expect(sawHurtUnit, '两分钟的兵全在满血散步，那才是没交火').toBe(true);
  });
});

describe('时间轴：3 分钟到点必须分胜负（原来一半的局永远打不完）', () => {
  /**
   * 造一个"没人动"的场：红方 AI 也关掉，只走时间。
   * `auto` 是 readonly，但那锁的是引用不是内容 —— 这里就是要翻它的开关。
   */
  function idle(seed = 1): ArenaWorld {
    const w = new ArenaWorld({ seed });
    w.auto.red = false;
    return w;
  }

  it('配置自洽：告急窗口落在全场之内', () => {
    expect(MATCH.seconds).toBeGreaterThan(0);
    expect(MATCH.warnSeconds).toBeLessThanOrEqual(MATCH.seconds);
  });

  it('倒计时从全场时长开始往下掉（不是一直读 3:00）', () => {
    const w = idle();
    expect(w.summary().timeLeft).toBe(MATCH.seconds);
    run(w, 10);
    expect(w.summary().timeLeft).toBe(MATCH.seconds - 10);
  });

  it('打满"常规 + 加时"、大本营满血、拆楼数一样 ⇒ 平局，而且理由是 draw 不是 core', () => {
    const w = idle();
    run(w, MATCH.seconds + 1);
    // 2026-11-06 加时赛：常规 3 分钟到点**不再直接判**，先进加时 —— 这一条在加时锁里钉
    expect(w.outcome).toBe('playing');
    run(w, MATCH.overtimeSeconds + 1);
    expect(w.outcome).toBe('draw');
    expect(w.outcomeReason).toBe('draw');
  });

  it('加时打满比大本营剩血：蓝方少 200 血就判负，理由写 overtime（不是"大本营被拆"）', () => {
    const w = idle();
    w.coreOf('blue')!.hp -= 200;
    w.elapsed = MATCH.seconds + MATCH.overtimeSeconds - 0.5;
    run(w, 1);
    expect(w.outcome).toBe('lose');
    expect(w.outcomeReason).toBe('overtime');
  });

  /**
   * 判据是**拆掉对方的楼数**，不是"还剩几栋楼"。
   * 后者奖励铺楼（实测 12 局按剩楼数判是蓝 1 胜 / 红 9 胜，而蓝方只是盖得少），
   * 和"建筑要协调经济"的设计正好打架。
   */
  it('大本营剩血一样时比"拆掉的楼数"：你拆 2 栋、对方拆 0 栋 ⇒ 判赢', () => {
    const w = idle();
    w.destroyed.blue = 0;
    w.destroyed.red = 2;
    w.elapsed = MATCH.seconds + MATCH.overtimeSeconds - 0.5;
    run(w, 1);
    expect(w.outcome).toBe('win');
    expect(w.outcomeReason).toBe('overtime');
  });

  it('真把一栋楼拆掉，账本上记的是"被拆的那一方"', () => {
    const w = idle();
    // 红方在自己的半场立一座塔，把血压到 10，再塞一个蓝方骑士到它边上
    give(w, 'arrowTower', 'red');
    w.gold.red = cardById('arrowTower').cost;
    expect(w.playCard('red', 0, 30, 6).ok).toBe(true);
    const tower = [...w.buildings.values()].find((b) => b.side === 'red' && b.kind === 'arrowTower')!;
    tower.hp = 10;
    w.units.push({
      id: 9001,
      side: 'blue',
      defId: 'knight',
      x: tower.col - 1,
      z: tower.row + tower.rows / 2,
      hp: 60,
      maxHp: 60,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1,
    });
    run(w, 4);
    expect(w.destroyed.red).toBe(1);
    expect(w.destroyed.blue).toBe(0);
  });

  it('大本营先碎优先于时间到：最后一秒红大本营没了，就是拆大本营赢', () => {
    const w = idle();
    const redCore = w.coreOf('red')!;
    w.buildings.delete(redCore.id);
    w.elapsed = MATCH.seconds - 0.01;
    run(w, 0.1);
    expect(w.outcome).toBe('win');
    expect(w.outcomeReason).toBe('core');
  });

  /**
   * 金币在 2026-10-31 被**调慢**了一档（1.5 秒/格 → 2.5 秒/格）。
   * 理由是用户那句话："金钱的问题改得慢一点……主要的设计目的是要求建筑协调经济"。
   * 钱一多，铺楼就变成无脑动作，民居/磨坊那道硬约束立刻被钱冲垮。
   */
  it('金币慢了一档：10 秒只涨 5（2 秒/格），充满 20 要 40 秒', () => {
    expect(ECONOMY.tickSeconds).toBe(2);
    const w = idle();
    w.gold.blue = 0;
    run(w, 10);
    expect(w.gold.blue).toBe(5);
  });

  it('金币还是涨到 20 就停（慢不等于没有上限）', () => {
    const w = idle();
    w.gold.blue = 0;
    run(w, 60);
    expect(w.gold.blue).toBe(ECONOMY.cap);
  });

  /**
   * 这一条就是本轮改动的**目的**，也是它的反证：
   * 改动前跑这一条，seed 1/3/4/6 会留在 playing（实测跑 600 秒都不结束）。
   * 2026-11-06 加时赛：时长从"全场 + 20"加长到"全场 + 加时 + 20"。
   */
  it('8 个 seed 各跑"全场 + 加时 + 20 秒"，一局都不许还挂着 playing', () => {
    const stuck: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const w = new ArenaWorld({ seed, auto: { blue: true } });
      run(w, MATCH.seconds + MATCH.overtimeSeconds + 20);
      if (w.outcome === 'playing') stuck.push(seed);
    }
    expect(stuck, `这些 seed 到点还没结束：${stuck.join(',')}`).toEqual([]);
  });
});

/**
 * 加时赛（2026-11-06 用户："一般来说没拆掉大本营有一个加时赛"）。
 *
 * 口径：常规 180 秒打满、两边大本营都还立着 ⇒ **不判胜负**，续 60 秒 sudden death ——
 * 加时里谁先拆掉对面大本营谁赢；加时也打满，才回落到"比剩血 → 比拆楼"的老判据。
 *
 * 设计动机（用户上一轮就抱怨过的那种局）：大本营挨了半刀的一边按老规则"看起来输了"，
 * 但它根本没被拆掉 —— 没拆掉大本营就不该提前判输赢。
 */
describe('加时赛：没拆掉大本营就不判（2026-11-06）', () => {
  function idle(seed = 51): ArenaWorld {
    const w = new ArenaWorld({ seed });
    w.auto.red = false;
    return w;
  }

  it('常规 3 分钟打满、双方大本营都在 ⇒ 不判负，进加时（outcome 仍 playing）', () => {
    const w = idle();
    run(w, MATCH.seconds + 1);
    expect(w.outcome).toBe('playing');
    expect(w.overtime).toBe(true);
    // 倒计时重置成加时剩余（不会读 0）
    expect(w.timeLeft).toBeGreaterThan(0);
    expect(w.timeLeft).toBeLessThanOrEqual(MATCH.overtimeSeconds);
    expect(w.summary().overtime).toBe(true);
  });

  it('常规 3 分钟内 ⇒ 不算加时（overtime 关着）', () => {
    const w = idle();
    run(w, 10);
    expect(w.overtime).toBe(false);
    expect(w.summary().overtime).toBe(false);
  });

  it('加时里谁先拆掉对面大本营谁赢 —— sudden death，不等到加时打满', () => {
    const w = idle();
    run(w, MATCH.seconds + 5);
    expect(w.overtime).toBe(true);
    w.buildings.delete(w.coreOf('red')!.id);
    run(w, 0.2);
    expect(w.outcome).toBe('win');
    expect(w.outcomeReason).toBe('core');
  });

  /**
   * 反证：老判据在加时打满之前**不许生效** ——
   * 蓝方大本营只剩 100 血（按老规则 180 秒一到就该判负），加时里照样接着打。
   */
  it('反证：大本营残血但常规时间刚到 ⇒ 不判负，加时里还有机会翻盘', () => {
    const w = idle();
    w.coreOf('blue')!.hp = 100;
    w.elapsed = MATCH.seconds + 0.1;
    run(w, 1);
    expect(w.outcome, '100 血≠被拆掉，不许提前判负').toBe('playing');
  });
});

/**
 * 黄区（禁建带）2026-11-02 加宽到 7 列。
 *
 * 用户当时问："为什么敌方的建筑可以直接建到黄色区域" ——
 * 实测逻辑层一处都没违规（20 个 seed、441 栋楼，压线 0 处），
 * 他看到的是**建筑模型比占地宽**（兵营 3.6 格 vs 占地 3 格），贴着黄线盖就会伸进去 0.3 格。
 * 所以除了加宽，还把 AI 的落点又往外让了一格。
 */
describe('禁建带：7 列，玩家和 AI 都放不进去', () => {
  it('宽度是 9 列（midCol ± 4）', () => {
    expect(NO_BUILD.halfWidth).toBe(4);
    expect(NO_BUILD.halfWidth * 2 + 1).toBe(9);
  });

  it('玩家把楼按在带子上会被拒，理由是黄区', () => {
    const world = new ArenaWorld({ seed: 77 });
    give(world, 'house');
    const res = world.playCard('blue', 0, FIELD.midCol - 1, 8);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('黄区');
  });

  /** 反证：把 margin 改回 `halfWidth + 1`，这条会抓到"楼贴在黄线上"。 */
  it('6 个 seed 各打满 3 分钟，没有一栋楼压进带子', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const w = new ArenaWorld({ seed, auto: { blue: true } });
      run(w, 180);
      for (const b of w.buildings.values()) {
        for (let c = b.col; c < b.col + b.cols; c++) {
          const inBand = c >= FIELD.midCol - NO_BUILD.halfWidth && c <= FIELD.midCol + NO_BUILD.halfWidth;
          expect(inBand, `seed ${seed}：${b.side} 的 ${b.kind} 占了 col ${c}`).toBe(false);
        }
      }
    }
  });
});

/**
 * 黄区只禁「落位」，不禁「开火」（用户 2026-11-06："黄色地方不能建筑，
 * 但防御建筑对站在黄色区域的单位是可以正常开火的。开火不影响，只是不允许建筑。"）。
 *
 * 索敌（`nearestTowerTarget`）从头到尾只看距离与阵营，没有一处读 `inNoBuild` ——
 * 这组锁把「能开火」钉成判据，以后谁往索敌里塞黄区过滤都会在这里翻车。
 * 靶子用 `stun` 钉在原地（被打不能还手、也不走动），不然 2 秒里它自己就走出带子了。
 */
describe('黄区只禁落位、不禁开火（2026-11-06）', () => {
  /** 一枚被钉死的靶子：站在给定位置，不动手也不走。 */
  function dummyPinned(w: ArenaWorld, side: 'blue' | 'red', id: number, x: number, z: number): void {
    w.units.push({
      id,
      side,
      defId: 'knight',
      x,
      z,
      hp: 600,
      maxHp: 600,
      cooldown: 0,
      stun: 999, // 钉死：既不还手也不挪窝，站在带子里当靶子
      order: null,
      detour: 1,
    });
  }

  it('敌兵站在黄区带子里：配齐民居的蓝方箭塔照常开火、照常掉血', () => {
    const w = new ArenaWorld({ seed: 91 });
    w.auto.red = false;
    instant(w, 'blue', 'arrowTower', 14, 10, 520); // 塔占 col 14–16，中心 x=15.5
    instant(w, 'blue', 'house', 5, 10, 220);
    // 靶子站在带子最左沿（col 18 ⇒ x=18.5，inNoBuild(18)=true），离塔心 3 格、在射程内
    dummyPinned(w, 'red', 9101, 18.5, 11.5);
    expect(w.inNoBuild(18)).toBe(true);
    let fired = false;
    run(w, 2, () => {
      if (w.shots.some((s) => s.source === 'arrowTower')) fired = true;
    });
    const hp = w.units.find((u) => u.id === 9101)?.hp ?? 600;
    expect(fired, '站在黄区里的敌兵应当照样挨塔的打').toBe(true);
    expect(hp, '打中了就要掉血').toBeLessThan(600);
  });

  it('对称：红方箭塔对站在带子里的我方（蓝方）兵也照常开火', () => {
    const w = new ArenaWorld({ seed: 92 });
    w.auto.red = false;
    w.auto.blue = false;
    instant(w, 'red', 'arrowTower', 27, 10, 520); // 红方半场最靠中线的位置，中心 x=28.5
    instant(w, 'red', 'house', 38, 10, 220);
    dummyPinned(w, 'blue', 9102, 26.5, 11.5); // 带子最右沿（col 26）
    expect(w.inNoBuild(26)).toBe(true);
    let fired = false;
    run(w, 2, () => {
      if (w.shots.some((s) => s.source === 'arrowTower')) fired = true;
    });
    const hp = w.units.find((u) => u.id === 9102)?.hp ?? 600;
    expect(fired, '红塔也应当打得到黄区里的蓝兵').toBe(true);
    expect(hp).toBeLessThan(600);
  });

  /**
   * 反证：同样的位置、只把民居拿走 ⇒ 不开火。
   * 和上面两条合成一对：用户看到"塔对着黄区里的人不出手"时，先怀疑民居缺配，
   * 不是黄区 —— 那是设计行为（"缺配 = 停摆"），不是这条禁建带拦的。
   */
  it('反证：同样站位没有民居就不开火 —— 停的是配给，不是黄区', () => {
    const w = new ArenaWorld({ seed: 93 });
    w.auto.red = false;
    instant(w, 'blue', 'arrowTower', 14, 10, 520);
    dummyPinned(w, 'red', 9103, 18.5, 11.5);
    let fired = false;
    run(w, 2, () => {
      if (w.shots.some((s) => s.source === 'arrowTower')) fired = true;
    });
    expect(fired, '没有民居时不开火（和黄区无关）').toBe(false);
  });
});

/**
 * 建筑要盖几秒（2026-11-02）。
 *
 * 用户："这个建筑建起来是要时间的……有几个脚手架，建筑慢慢升起来，
 * 那个墙壁就慢慢地凭空垒上来了。"
 *
 * 逻辑层只认 `b.build` 到没到 1：没到就**什么都不干**（塔不开火、兵营不出兵、磨坊不生金），
 * 也不吃后勤名额。脚手架 / 墙体露出 / 楼体升起都是视图层的事（靠实机截图验）。
 */
describe('建筑要盖几秒：施工期间不干活', () => {
  it('每种楼都有施工时长，而且都不短于 2 秒', () => {
    for (const [kind, sec] of Object.entries(BUILD.seconds)) {
      expect(sec, kind).toBeGreaterThanOrEqual(2);
    }
  });

  it('playCard 落下去的楼从 0 开始垒，跑够时间才到 1', () => {
    const world = new ArenaWorld({ seed: 41 });
    world.auto.red = false;
    world.gold.blue = 20;
    give(world, 'house');
    expect(world.playCard('blue', 0, 6, 8).ok).toBe(true);
    const house = [...world.buildings.values()].find((b) => b.kind === 'house')!;
    expect(house.build).toBe(0);
    run(world, BUILD.seconds.house * 0.5);
    expect(house.build).toBeGreaterThan(0.3);
    expect(house.build).toBeLessThan(0.8);
    run(world, BUILD.seconds.house);
    expect(house.build).toBe(1);
  });

  it('施工中的塔不开火，垒完才开火', () => {
    const world = new ArenaWorld({ seed: 42 });
    world.auto.red = false;
    world.gold.blue = 20;
    // 民居先直接放好（不然"不开火"分不清是缺人手还是没垒完）
    instant(world, 'blue', 'house', 9, 10, 220);
    give(world, 'arrowTower');
    expect(world.playCard('blue', 0, 14, 10).ok).toBe(true);
    // 靶子摆进箭塔射程（塔中心 15.5，靶子在 20：边缘距离 3 格）
    world.units.push({
      id: 9300,
      side: 'red',
      defId: 'knight',
      x: 20,
      z: 10.5,
      hp: 600,
      maxHp: 600,
      cooldown: 0,
      stun: 0,
      order: null,
      detour: 1,
    });
    const everFired = (seconds: number): boolean => {
      let fired = false;
      run(world, seconds, () => {
        if (world.shots.some((s) => s.source === 'arrowTower')) fired = true;
      });
      return fired;
    };
    expect(everFired(3)).toBe(false);
    expect(everFired(1.5)).toBe(true);
  });

  it('施工中的磨坊不生金，施工中的兵营不出兵', () => {
    const world = new ArenaWorld({ seed: 43 });
    world.auto.red = false;
    world.gold.blue = 20;
    give(world, 'mill');
    expect(world.playCard('blue', 0, 6, 8).ok).toBe(true);
    const before = world.gold.blue;
    // 施工只到一半：这 2 秒里金只能按"每 2 秒 +1"涨，不该有磨坊那 +2
    run(world, BUILD.seconds.mill * 0.5);
    expect(world.gold.blue - before).toBeLessThanOrEqual(1);

    const w2 = new ArenaWorld({ seed: 44 });
    w2.auto.red = false;
    w2.gold.blue = 20;
    give(w2, 'barracks');
    expect(w2.playCard('blue', 0, 5, 10).ok).toBe(true);
    instant(w2, 'blue', 'mill', 10, 10, 300);
    instant(w2, 'blue', 'house', 10, 5, 220);
    run(w2, BUILD.seconds.barracks * 0.8);
    expect(w2.units.filter((u) => u.side === 'blue')).toHaveLength(0);
  });

  it('施工中的楼不抢民居名额（还没干活的楼先把人手让给兵营）', () => {
    const world = new ArenaWorld({ seed: 45 });
    world.auto.red = false;
    world.gold.blue = 20;
    instant(world, 'blue', 'barracks', 4, 4, 420);
    instant(world, 'blue', 'mill', 10, 4, 300);
    instant(world, 'blue', 'house', 10, 10, 220);
    expect(world.supportedBarracks('blue')).toBe(1);
    // 再盖一座塔：它还在施工，不该把兵营的民居抢走
    give(world, 'arrowTower');
    expect(world.playCard('blue', 0, 15, 4).ok).toBe(true);
    expect(world.supportedBarracks('blue')).toBe(1);
    // 塔垒完之后才会参与分配 —— 这时民居只剩 0 座，兵营先到先得仍然开工
    run(world, BUILD.seconds.arrowTower + 0.1);
    expect(world.supportedBarracks('blue')).toBe(1);
  });
});

/**
 * AI 的决策（纯函数）—— 2026-11-02 从 `ArenaWorld` 里抽到 `ai.ts` 之后才写得起这种锁。
 *
 * 以前只能"跑 60 秒看它出了什么牌"，慢而且说不清是哪一步错；
 * 现在给一份手牌就能断言"这一轮该出第几格"。
 */
describe('AI 决策：出哪张、什么时候攒钱', () => {
  const view = (ids: (string | null)[], gold: number, counts: Record<string, number> = {}) => ({
    hand: ids.map((id) => (id ? cardById(id) : null)),
    gold,
    count: (kind: string) => counts[kind] ?? (kind === 'core' ? 1 : 0),
  });

  it('场上还没有民居：先出民居（名额永远排在"盖新楼"前面）', () => {
    expect(chooseCard(view(['house', 'archers', 'mages', null], 20))).toBe(0);
  });

  it('有民居但没有塔：出塔，而不是继续堆民居', () => {
    // 手上有两张建筑卡时，拣愿望清单里更靠前的那张
    const slot = chooseCard(view(['house', 'arrowTower', 'archers', null], 20, { house: 1 }));
    expect(slot).toBe(1);
  });

  it('建筑买不起就攒钱：不把最后 6 金花在一队弓箭手上', () => {
    // 手里只有塔（10 金）和民居（6 金已经够了），钱 6 金 —— 塔买不起，且塔是建筑 ⇒ 等
    const slot = chooseCard(view(['arrowTower', 'archers', 'mages', null], 6, { house: 1 }));
    expect(slot).toBeNull();
  });

  it('军队买不起最想要的那张时，能出什么先出什么', () => {
    // 建筑都齐了（2 塔 + 1 兵营 + 后勤），剩下的愿望全是军队；11 金的法师买不起，6 金的弓箭手能出
    const counts = { house: 3, mill: 1, barracks: 1, arrowTower: 1, cannonTower: 1 };
    const slot = chooseCard(view(['mages', 'archers', null, null], 6, counts));
    expect(slot).toBe(1);
  });

  it('手上一张牌都没有（全在冷却）时不出牌，也不报错', () => {
    expect(chooseCard(view([null, null, null, null], 20))).toBeNull();
  });

  it('愿望清单的第一项永远是后勤，不是军队', () => {
    const wish = wishList(() => 0);
    expect(wish[0]).toBe('house');
    expect(wish.indexOf('archers')).toBeGreaterThan(wish.indexOf('barracks'));
  });
});

/**
 * 命中特效事件（2026-11-05 用户："近战和远程都要有不同的粒子放射"）。
 *
 * 分工：**近战**上报 `world.hits`（没有飞行物，视图只能靠事件知道"这一下打中了"）；
 * **远程**不上报 —— 它有弹丸，视图在弹丸飞到目标那一刻自己放 `impact`，
 * 再报一次就是双重特效（炮弹落地会炸两次）。
 */
describe('命中特效：近战上报事件，远程不重复上报', () => {
  const dude = (id: number, side: 'blue' | 'red', defId: string, x: number) => ({
    id,
    side,
    defId,
    x,
    z: 10.5,
    hp: 999,
    maxHp: 999,
    cooldown: 0,
    stun: 0,
    order: null,
    detour: 1 as const,
  });

  it('两个近战贴上去互砍 → 会上报命中事件', () => {
    const world = new ArenaWorld({ seed: 61 });
    world.auto.blue = false;
    world.auto.red = false;
    world.units.push(dude(6001, 'blue', 'knight', 10), dude(6002, 'red', 'knight', 11.2));
    let seen = 0;
    for (let i = 0; i < 80; i++) {
      world.update(0.05);
      seen = Math.max(seen, world.hits.length);
    }
    expect(seen).toBeGreaterThan(0);
    expect(world.units.length).toBe(2); // 血 999，不该打死
  });

  it('弓箭手（有弹丸）全程不上报 —— 远程的特效由弹丸自己放', () => {
    const world = new ArenaWorld({ seed: 62 });
    world.auto.blue = false;
    world.auto.red = false;
    // 两**边**都得是远程：红方要是骑士，它冲上来砍人一样会上报（那是对的，不是这条要测的）
    world.units.push(dude(6101, 'blue', 'archer', 10), dude(6102, 'red', 'archer', 13.5));
    let shots = 0;
    let hits = 0;
    for (let i = 0; i < 80; i++) {
      world.update(0.05);
      shots = Math.max(shots, world.shots.length);
      hits = Math.max(hits, world.hits.length);
    }
    expect(shots).toBeGreaterThan(0); // 确实开火了
    expect(hits).toBe(0); // 但没有上报近战事件
  });
});

/**
 * 人口 / 面包 —— 用户 2026-11-05 定的「**容器**」：
 * 「面包和人口是恒定的，在左上角它们相当于是一个容器值，而不是一个会随时间增长的值。
 *  这就是我们限制建造和区分的一个东西。」
 *
 * 这一组锁钉的是"它只由场上的东西决定"：时间过去了读数不变、盖民居才涨、出兵才掉。
 */
describe('人口 / 面包：容器，不是随时间涨的收入', () => {
  it('开局：人口 0/6、面包 0/3（大本营不占）', () => {
    const w = new ArenaWorld({ seed: 71 });
    const s = w.supplyOf('blue');
    expect(s).toEqual({ pop: 0, popMax: SUPPLY.basePop, bread: 0, breadMax: SUPPLY.baseBread });
  });

  it('放着不打，30 秒后读数一点不变（不是收入）', () => {
    const w = new ArenaWorld({ seed: 72 });
    w.auto.red = false;
    const before = w.supplyOf('blue');
    run(w, 30);
    expect(w.supplyOf('blue')).toEqual(before);
  });

  it('民居 +2 人口上限，自己不占人口；塔和兵营各占 2', () => {
    const w = new ArenaWorld({ seed: 73 });
    w.auto.red = false;
    instant(w, 'blue', 'house', 4, 4, 220);
    expect(w.supplyOf('blue')).toEqual({ pop: 0, popMax: 8, bread: 0, breadMax: SUPPLY.baseBread });
    instant(w, 'blue', 'arrowTower', 8, 4, 520);
    instant(w, 'blue', 'barracks', 12, 4, 420);
    const s = w.supplyOf('blue');
    expect(s.pop).toBe(4);
    expect(s.popMax).toBe(8);
  });

  it('磨坊 +2 面包上限，但它要占 2 人口', () => {
    const w = new ArenaWorld({ seed: 74 });
    w.auto.red = false;
    instant(w, 'blue', 'mill', 4, 4, 300);
    expect(w.supplyOf('blue')).toEqual({ pop: 2, popMax: 6, bread: 0, breadMax: SUPPLY.baseBread + SUPPLY.millBread });
  });

  it('人口满了盖塔会被拒，理由里点出「人口」', () => {
    const w = new ArenaWorld({ seed: 75 });
    w.auto.red = false;
    w.gold.blue = 20;
    // 6 点人口 → 3 栋楼就满
    instant(w, 'blue', 'mill', 4, 4, 300);
    instant(w, 'blue', 'mill', 8, 4, 300);
    instant(w, 'blue', 'mill', 12, 4, 300);
    expect(w.supplyOf('blue').pop).toBe(6);
    give(w, 'arrowTower');
    const res = w.playCard('blue', 0, 6, 12);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('人口');
  });

  it('人口满的时候民居仍然盖得出来（否则永远死锁）', () => {
    const w = new ArenaWorld({ seed: 76 });
    w.auto.red = false;
    w.gold.blue = 20;
    instant(w, 'blue', 'mill', 4, 4, 300);
    instant(w, 'blue', 'mill', 8, 4, 300);
    instant(w, 'blue', 'mill', 12, 4, 300);
    give(w, 'house');
    expect(w.playCard('blue', 0, 6, 12).ok).toBe(true);
    expect(w.supplyOf('blue').popMax).toBe(8);
  });

  it('面包满了出兵会被拒，理由里点出「面包」', () => {
    const w = new ArenaWorld({ seed: 77 });
    w.auto.red = false;
    w.gold.blue = 20;
    // 基础面包（SUPPLY.baseBread）：摆满这么多兵就吃光
    for (let i = 0; i < SUPPLY.baseBread; i++) {
      w.units.push({
        id: 8000 + i, side: 'blue', defId: 'knight', x: 6 + i, z: 10,
        hp: 999, maxHp: 999, cooldown: 0, stun: 0, order: null, detour: 1,
      });
    }
    expect(w.supplyOf('blue').bread).toBe(SUPPLY.baseBread);
    // 用 2 人的骑士：人口 4+2=6 刚好够、面包 4+2=6 超了 —— 这样才撞到**面包**而不是人口
    give(w, 'knights');
    const res = w.playCard('blue', 0, 10, 12);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('面包');
  });

  it('兵死了，人口和面包都退回来', () => {
    const w = new ArenaWorld({ seed: 78 });
    w.auto.red = false;
    w.units.push({
      id: 8100, side: 'blue', defId: 'knight', x: 6, z: 10,
      hp: 999, maxHp: 999, cooldown: 0, stun: 0, order: null, detour: 1,
    });
    expect(w.supplyOf('blue').pop).toBe(1);
    expect(w.supplyOf('blue').bread).toBe(1);
    w.units[0]!.hp = 0;
    run(w, 0.2);
    expect(w.supplyOf('blue').pop).toBe(0);
    expect(w.supplyOf('blue').bread).toBe(0);
  });
});

/**
 * 手牌刷新（2026-11-06 用户）："有一个刷新所有卡牌需要花 5 个金币……
 * 因为我们这边民居是必要的，所以需要刷新，一般刷新的时候默认会给一张房屋。"
 *
 * 这几条钉住的是：钱要扣对、四张不重复、**每次都有一张民居**、冷却清掉。
 */
describe('手牌刷新：5 金、保底民居', () => {
  it('扣 5 金、四张互不重复', () => {
    const w = new ArenaWorld({ seed: 81 });
    w.auto.red = false;
    w.gold.blue = 12;
    const before = w.gold.blue;
    const res = w.reroll('blue');
    expect(res.ok).toBe(true);
    expect(w.gold.blue).toBe(before - REROLL.cost);
    const ids = w.hand.map((c) => c?.id);
    expect(ids.every((c) => c !== null)).toBe(true);
    expect(new Set(ids).size, ids.join('/')).toBe(HAND.size);
  });

  it('金币不够 5 会被拒，手牌一张都不动', () => {
    const w = new ArenaWorld({ seed: 82 });
    w.auto.red = false;
    w.gold.blue = REROLL.cost - 1;
    const before = w.hand.map((c) => c?.id);
    const res = w.reroll('blue');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('金币不够');
    expect(w.hand.map((c) => c?.id)).toEqual(before);
    expect(w.gold.blue).toBe(REROLL.cost - 1);
  });

  it('24 个 seed 连刷三次，每次都必有一张民居', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const w = new ArenaWorld({ seed });
      w.auto.red = false;
      w.gold.blue = ECONOMY.cap;
      for (let n = 0; n < 3; n++) {
        expect(w.reroll('blue').ok).toBe(true);
        const ids = w.hand.map((c) => c?.id);
        expect(ids, `seed ${seed} 第 ${n} 次：${ids.join('/')}`).toContain('house');
        expect(new Set(ids).size).toBe(HAND.size);
      }
    }
  });

  it('刷新会把四格的冷却清掉', () => {
    const w = new ArenaWorld({ seed: 83 });
    w.auto.red = false;
    w.gold.blue = ECONOMY.cap;
    w.handCooldowns.blue.fill(1.4);
    expect(w.reroll('blue').ok).toBe(true);
    expect(w.handCooldowns.blue.every((t) => t === 0)).toBe(true);
  });
});

/**
 * 军队的拆楼优先级（2026-11-06 用户）：
 * 「第一，攻击防御设施。第二，攻击大本营，除非路上有其他的建筑物，就优先攻击建筑物。」
 *
 * 实现是 `nearestHostile` 里的「距离 − 威胁加权」：塔 -4、其它建筑 -1.5、大本营 0。
 * 权重而不是硬分类，所以近处挡路的民居仍然压得过远处的塔。
 */
describe('军队优先拆防御设施，最后才打大本营', () => {
  const attacker = (x: number, z: number) => ({
    id: 9500, side: 'blue' as const, defId: 'knight', x, z,
    hp: 999, maxHp: 999, cooldown: 0, stun: 0, order: null, detour: 1 as const,
  });
  const pick = (w: ArenaWorld, u: ReturnType<typeof attacker>) =>
    w['nearestHostile'](u, 60, false)?.building ?? null;

  it('塔和大本营同时可见：先打塔', () => {
    const w = new ArenaWorld({ seed: 91 });
    w.auto.red = false;
    const u = attacker(10, 11.5);
    w.units.push(u);
    const tower = instant(w, 'red', 'arrowTower', 14, 10, 520);
    expect(pick(w, u)?.id, '应该先拆防御设施').toBe(tower.id);
  });

  it('没有防御设施时：先拆路上的普通建筑，而不是直奔大本营', () => {
    const w = new ArenaWorld({ seed: 92 });
    w.auto.red = false;
    const u = attacker(10, 11.5);
    w.units.push(u);
    const house = instant(w, 'red', 'house', 12, 10, 220);
    expect(pick(w, u)?.id).toBe(house.id);
  });

  it('近处的挡路民居压得过远处的塔（「除非路上有其他的建筑物」）', () => {
    const w = new ArenaWorld({ seed: 93 });
    w.auto.red = false;
    const u = attacker(10, 11.5);
    w.units.push(u);
    const house = instant(w, 'red', 'house', 12, 10, 220);
    instant(w, 'red', 'arrowTower', 22, 10, 520);
    expect(pick(w, u)?.id).toBe(house.id);
  });

  it('别的都没有了才轮到大本营', () => {
    const w = new ArenaWorld({ seed: 94 });
    w.auto.red = false;
    const u = attacker(10, 11.5);
    w.units.push(u);
    const core = w.coreOf('red')!;
    expect(pick(w, u)?.id).toBe(core.id);
  });

  it('贴脸的敌兵仍然先还手（自卫，不被拆楼优先级压掉）', () => {
    const w = new ArenaWorld({ seed: 95 });
    w.auto.red = false;
    const u = attacker(10, 11.5);
    w.units.push(u);
    const enemy = { ...attacker(11, 11.5), id: 9501, side: 'red' as const };
    w.units.push(enemy);
    instant(w, 'red', 'arrowTower', 14, 10, 520);
    const foe = w['nearestHostile'](u, 60, false);
    expect(foe?.unit?.id).toBe(enemy.id);
    expect(foe?.building).toBeUndefined();
  });
});

/**
 * 反证（2026-11-06）：旧 `reroll()` 永远只保 `house`，
 * 兵营缺磨坊时刷新会把刚补到的 mill 换走 —— 实测红方 180 秒 0 磨坊、面包永远满。
 * 新实现必须保 `missingLogistics()` 说的那张，同时仍保一张房屋。
 */
describe('刷新保底跟随后勤缺口', () => {
  it('缺磨坊时：刷新后 mill 和 house 都在手上', () => {
    const w = new ArenaWorld({ seed: 141 });
    w.auto.red = false;
    w.gold.blue = ECONOMY.cap;
    // 一座完工兵营、没有磨坊 ⇒ missingLogistics 返回 mill
    const b = instant(w, 'blue', 'barracks', 4, 8, 420);
    b.build = 1;
    const res = w.reroll('blue');
    expect(res.ok).toBe(true);
    const ids = w.hand.map((c) => c?.id);
    expect(ids).toContain('mill');
    expect(ids).toContain('house');
    expect(new Set(ids).size).toBe(HAND.size);
  });

  it('反证：什么都不缺时，仍然按用户原话保一张房屋', () => {
    const w = new ArenaWorld({ seed: 142 });
    w.auto.red = false;
    w.gold.blue = ECONOMY.cap;
    expect(w.reroll('blue').ok).toBe(true);
    expect(w.hand.map((c) => c?.id)).toContain('house');
  });
});

/**
 * 反证（2026-11-06）：旧判据 `mills < barracks` 在**还没盖兵营**时永远认为不缺磨坊，
 * 于是后勤保底从来不发 mill（实测 seed 20261027 全程只在手牌待 89 帧），
 * 面包上限卡死在基础 3 点，一队 3 人弓箭手一次吃光，之后军队卡全被 canPlay 拦住。
 * 新判据「至少要有一座磨坊」必须让开局刷新就带上它。
 */
describe('磨坊缺口：没有兵营也算缺', () => {
  it('开局什么都没盖：刷新必带 mill + house', () => {
    const w = new ArenaWorld({ seed: 151 });
    w.auto.red = false;
    w.gold.blue = ECONOMY.cap;
    expect(w.reroll('blue').ok).toBe(true);
    const ids = w.hand.map((c) => c?.id);
    expect(ids).toContain('mill');
    expect(ids).toContain('house');
    expect(new Set(ids).size).toBe(HAND.size);
  });

  it('已经有一座完工磨坊：不再把它算作缺口', () => {
    const w = new ArenaWorld({ seed: 152 });
    w.auto.red = false;
    const m = instant(w, 'blue', 'mill', 4, 8, 300);
    m.build = 1;
    expect(w['missingLogisticsAll']('blue')).not.toContain('mill');
  });
});

/**
 * 兵营出的兵不占人口（2026-11-06 用户："兵营里面出的兵不占人口"）。
 *
 * 口径：兵营的兵 `fromBarracks = true` ⇒ **不算人口占用**（卡牌出的兵照算），
 * 面包照吃 —— 不占人口 ≠ 白吃饭，磨坊仍然是"能养多少兵"的真闸门。
 * 容器限制管的本来就是"玩家一次掏牌放多少兵"，兵营产线不该被自己的楼挤死
 *（楼本身已经占了 2 人口）。
 */
describe('兵营的兵不占人口（2026-11-06）', () => {
  /** 配齐后勤的一座蓝方兵营：磨坊 + 民居，自动出兵线是活的 */
  function staffedBarracks(seed: number): ArenaWorld {
    const w = new ArenaWorld({ seed });
    w.auto.red = false;
    instant(w, 'blue', 'barracks', 3, 8, 420);
    instant(w, 'blue', 'mill', 9, 8, 300);
    instant(w, 'blue', 'house', 14, 8, 220);
    return w;
  }

  it('同一枚兵，fromBarracks=true 不占人口、false 照占 —— 判据只看这个旗', () => {
    const w = new ArenaWorld({ seed: 161 });
    w.auto.red = false;
    const pop0 = w.supplyOf('blue').pop;
    const mk = (fromBarracks: boolean) => ({
      id: fromBarracks ? 16101 : 16102,
      side: 'blue' as const,
      defId: 'knight',
      x: 6, z: 10,
      hp: 60, maxHp: 60,
      cooldown: 0, stun: 0, order: null, detour: 1 as const,
      fromBarracks,
    });
    w.units.push(mk(false));
    expect(w.supplyOf('blue').pop, '卡牌兵照占').toBe(pop0 + SUPPLY.unitPop);
    expect(w.supplyOf('blue').bread, '卡牌兵吃面包').toBe(SUPPLY.unitBread);
    w.units.pop();
    w.units.push(mk(true));
    expect(w.supplyOf('blue').pop, '兵营兵不占').toBe(pop0);
    expect(w.supplyOf('blue').bread, '面包不豁免：两种兵都吃').toBe(SUPPLY.unitBread);
  });

  it('兵营连续出兵不卡人口：产线持续吐兵（面包封顶），人口读数只数建筑', () => {
    const w = staffedBarracks(162);
    // 2026-11-06 水晶攻击后：兵走到红方主城会被水晶打死，"活着几个"不再是产线读数
    // —— 改数**累计出过几个**（seen），活着的只用于面包账。
    const seen = new Set<number>();
    run(w, 60, () => {
      for (const u of w.units) if (u.side === 'blue' && u.fromBarracks) seen.add(u.id);
    });
    expect(seen.size, '60 秒产线至少吐 5 个（面包 3+2=5 封顶）').toBeGreaterThanOrEqual(5);
    const sup = w.supplyOf('blue');
    // 占用只数楼：兵营 2 + 磨坊 2 + 民居 0 = 4，人口读数不该被兵顶上去
    expect(sup.pop).toBe(4);
    const alive = [...w.units].filter((u) => u.side === 'blue' && u.hp > 0).length;
    expect(sup.bread, '面包照吃：活着的兵每个吃 1').toBe(Math.min(sup.breadMax, alive));
    expect(w.summary().supply.blue.pop).toBe(4);
  });

  it('反证：卡牌兵仍占人口 —— 例外只给兵营自己', () => {
    const w = staffedBarracks(163);
    // 开局面包 0，还没有兵营兵：直接看卡牌兵的人口账（差值 = 2 个骑士 × 1 人口）
    instant(w, 'blue', 'mill', 18, 8, 300);
    const before = w.supplyOf('blue');
    give(w, 'knights');
    w.gold.blue = ECONOMY.cap;
    const res = w.playCard('blue', 0, 4, 16);
    expect(res.ok, `卡牌兵应当能出（res=${res.reason}）`).toBe(true);
    const after = w.supplyOf('blue');
    expect(after.pop - before.pop).toBe(2 * SUPPLY.unitPop);
  });
});

/**
 * 槽位制衡（2026-11-06 用户："不能一建一堆建筑物，最高需要留一些槽位给军队"）：
 * **建筑占用最多到 人口上限 − 2**。这是规则不是 AI 习惯 —— 玩家受同一条管。
 * 民居不在此列（先加容器再看占用，防死锁）；军队卡就是保留槽的主人。
 */
describe('槽位制衡：建筑最多占 上限−2（P-042）', () => {
  /** 一个"建筑名额顶死"的场：磨坊 2 人口 + 箭塔 2 人口 = 4/6，只剩保留槽 */
  function packed(seed = 171): ArenaWorld {
    const w = new ArenaWorld({ seed });
    w.auto.red = false;
    instant(w, 'blue', 'mill', 2, 6, 300);
    instant(w, 'blue', 'arrowTower', 9, 6, 520);
    return w;
  }

  it('pop 4/6：再盖楼被拒，理由点名「给军队留格」', () => {
    const w = packed();
    give(w, 'arrowTower');
    w.gold.blue = 20;
    const res = w.playCard('blue', 0, 2, 12);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('军队');
  });

  it('民居不在此列：顶住时照样盖（先加容器再看占用，不死锁）', () => {
    const w = packed();
    give(w, 'house');
    w.gold.blue = 20;
    expect(w.playCard('blue', 0, 2, 12).ok).toBe(true);
    expect(w.supplyOf('blue').popMax).toBe(8);
  });

  it('军队不受限：2 人小队照样放（保留槽就是留给它的）', () => {
    const w = packed();
    give(w, 'orcs');
    w.gold.blue = 20;
    expect(w.playCard('blue', 0, 6, 14).ok).toBe(true);
  });

  it('盖一座民居扩容后楼又能盖了 —— 制衡是节奏，不是封死', () => {
    const w = packed();
    give(w, 'house');
    w.gold.blue = 20;
    expect(w.playCard('blue', 0, 2, 12).ok).toBe(true);
    give(w, 'arrowTower');
    w.handCooldowns.blue[0] = 0;
    const res = w.playCard('blue', 0, 14, 12);
    expect(res.ok, `res=${res.reason ?? ''}`).toBe(true);
  });
});

/**
 * 大本营水晶魔法攻击（2026-11-06 用户："主城就是可以射击，顶上的水晶可以魔法攻击"）。
 * 口径：只打兵、不配给（地图本身）、射程从占地边缘量（+1.5）—— config.CORE.attack。
 */
describe('大本营水晶：魔法攻击（P-043）', () => {
  /** 钉死的红方靶子（和黄区开火那组同一招） */
  function pinned(w: ArenaWorld, id: number, x: number, z: number): void {
    w.units.push({
      id,
      side: 'red',
      defId: 'knight',
      x, z,
      hp: 200, maxHp: 200,
      cooldown: 0, stun: 999, order: null, detour: 1,
    });
  }

  it('敌兵进射程：水晶开火（source=core 的 magic 弹）并掉血 —— 不需要民居配给', () => {
    const w = new ArenaWorld({ seed: 181 });
    w.auto.red = false;
    // 蓝方大本营中心 (2.5, 9.5)；靶子放在距中心 6.5 格（边缘外 5 格 < 5.5 射程）
    pinned(w, 9101, 9, 9.5);
    let fired = false;
    run(w, 2, () => {
      if (w.shots.some((s) => s.source === 'core' && s.ammo === 'magic')) fired = true;
    });
    expect(fired, '水晶应当对射程内的敌兵开火').toBe(true);
    const hp = w.units.find((u) => u.id === 9101)?.hp ?? 200;
    expect(hp, '魔法弹要掉血').toBeLessThan(200);
  });

  it('只打兵不打建筑：射程内只有敌楼时水晶不出手（攻城武器仍能白嫖大本营）', () => {
    const w = new ArenaWorld({ seed: 182 });
    w.auto.red = false;
    w.auto.blue = false;
    // 红方塔立在蓝方大本营射程内：塔中心 (8.5,10.5)，距蓝core中心 hypot(6,1)=6.08 − 边缘 1.5 = 4.58 < 5.5
    const t = instant(w, 'red', 'arrowTower', 7, 9, 520);
    const d = Math.hypot(t.col + 1.5 - 2.5, t.row + 1.5 - 9.5) - Math.max(t.cols, t.rows) / 2;
    expect(d, '靶楼必须在水晶射程内，这条锁才有意义').toBeLessThan(5.5);
    let fired = false;
    run(w, 2.5, () => {
      if (w.shots.some((s) => s.source === 'core')) fired = true;
    });
    expect(fired, '水晶只自卫打兵，不参与拆楼').toBe(false);
  });

  it('射程从占地边缘量：边缘外 5.8 格打不着（> 5.5），5.2 格打得着', () => {
    const w = new ArenaWorld({ seed: 183 });
    w.auto.red = false;
    pinned(w, 9102, 2.5 + 1.5 + 5.8, 9.5); // 距中心 7.3 > 5.5 + 1.5
    let fired = false;
    run(w, 2, () => {
      if (w.shots.some((s) => s.source === 'core')) fired = true;
    });
    expect(fired).toBe(false);

    const w2 = new ArenaWorld({ seed: 184 });
    w2.auto.red = false;
    pinned(w2, 9103, 2.5 + 1.5 + 5.2, 9.5); // 距中心 6.7 < 7
    let fired2 = false;
    run(w2, 2, () => {
      if (w2.shots.some((s) => s.source === 'core')) fired2 = true;
    });
    expect(fired2, '边缘量距：6.7 < 5.5+1.5 应当打得到').toBe(true);
  });
});

/**
 * 守家拦截（2026-11-06 用户："敌人已经过境了，我方的军队还在家里面，
 * 并没有保护家园，而是往对面冲"）：敌兵摸进我方腹地（距我大本营 < 12）
 * ⇒ 我方兵索敌视野扩到 9，转身追打过境的敌人。反证：敌人没入侵腹地就不回头。
 */
describe('守家拦截：过境的敌人要回头打（P-044）', () => {
  /** 蓝方骑士 + 一枚钉死/自由的红兵 */
  function pair(seed: number, redX: number): { w: ArenaWorld; blue: ArenaUnit; dist: () => number } {
    const w = new ArenaWorld({ seed });
    w.auto.red = false;
    w.auto.blue = false;
    w.units.push({
      id: 9401, side: 'blue', defId: 'knight', x: 15, z: 10,
      hp: 100, maxHp: 100, cooldown: 0, stun: 0, order: null, detour: 1,
    });
    w.units.push({
      id: 9402, side: 'red', defId: 'orc', x: redX, z: 10,
      hp: 200, maxHp: 200, cooldown: 0, stun: 999, order: null, detour: 1,
    });
    const blue = w.units.find((u) => u.id === 9401)!;
    const red = w.units.find((u) => u.id === 9402)!;
    return { w, blue, dist: () => Math.hypot(blue.x - red.x, blue.z - red.z) };
  }

  it('敌兵摸进腹地（距核心 5.5 < 12）：家里的兵转身拦截（x 回头、距离拉近）', () => {
    // 红兵在 x=8：距蓝方大本营中心 (2.5,9.5) 仅 5.5 —— 已入侵；距蓝兵 7 > 4.2（普通视野看不到）
    const { w, blue, dist } = pair(191, 8);
    const x0 = blue.x;
    const d0 = dist();
    expect(d0, '前置：普通视野（4.2）看不到，这条锁量的才是拦截').toBeGreaterThan(4.2);
    run(w, 2);
    expect(blue.x, '应当转身往回走（x 减小），而不是继续往对面冲').toBeLessThan(x0);
    expect(dist(), '拦截 = 主动拉近和入侵者的距离').toBeLessThan(d0);
  });

  it('反证：敌兵跟在身后但不在腹地内（距核心 26.5 > 12）→ 不回头，继续推进', () => {
    // 蓝骑士已推进到红方半场 x=34；红兵钉在它**身后** x=29（距蓝核心 26.5，未入侵蓝方腹地）。
    // 若警报误判成全局，蓝骑士会转身回追（x 减小）；正确行为是继续朝红方大本营推进。
    const { w, blue, dist } = pair(192, 29);
    w.units.find((u) => u.id === 9401)!.x = 34;
    const x0 = 34;
    run(w, 2);
    expect(blue.x, '腹地没被入侵就继续推进（x 增大）').toBeGreaterThan(x0 + 1);
    expect(dist(), '不回头追身后的敌兵').toBeGreaterThan(5.5);
  });
});

/**
 * 加时积分（2026-11-06 用户："最长到 5 分钟结束之后，按照局内双方建筑的
 * 存活数来比拼积分"）。⚠️ 这条**推翻**了 10-31"刻意不用剩楼数"的旧决策 ——
 * 用户拍板的口径，铺楼从此有积分价值（理由见 config.MATCH 注释）。
 */
describe('加时打满按存活数比积分（P-044）', () => {
  it('总时长 = 常规 180 + 加时 120 = 5 分钟', () => {
    expect(MATCH.overtimeSeconds).toBe(120);
    expect(MATCH.seconds + MATCH.overtimeSeconds).toBe(300);
  });

  it('存活楼多者胜：蓝 3 栋 vs 红 1 栋 ⇒ 蓝赢（哪怕蓝拆的楼更少）—— 新口径锁', () => {
    const w = new ArenaWorld({ seed: 193 });
    w.auto.red = false;
    instant(w, 'blue', 'house', 4, 4, 220);
    instant(w, 'blue', 'house', 4, 14, 220);
    instant(w, 'blue', 'house', 10, 8, 220);
    instant(w, 'red', 'house', 34, 8, 220);
    w.destroyed.blue = 0; // 蓝（玩家侧）没拆过楼
    w.destroyed.red = 2;  // 红拆了蓝两栋 —— 按旧"拆楼数"判据蓝必输
    w.elapsed = MATCH.seconds + MATCH.overtimeSeconds - 0.5;
    run(w, 1);
    expect(w.outcome, '新口径：存活数 3>1 压过拆楼劣势').toBe('win');
    expect(w.outcomeReason).toBe('overtime');
  });

  it('存活数一样 → 比大本营剩血；血也一样 → 比拆楼数（第三判据还在）', () => {
    const w = new ArenaWorld({ seed: 194 });
    w.auto.red = false;
    instant(w, 'blue', 'house', 4, 8, 220);
    instant(w, 'red', 'house', 34, 8, 220);
    w.destroyed.blue = 0;
    w.destroyed.red = 2;
    w.coreOf('blue')!.hp -= 200;
    w.elapsed = MATCH.seconds + MATCH.overtimeSeconds - 0.5;
    run(w, 1);
    expect(w.outcome).toBe('lose');
    expect(w.outcomeReason).toBe('overtime');
  });
});

/**
 * 单位碰撞体积（2026-11-06 用户："每个单位脚下会有一个看不见的小圆圈碰撞
 * 体积，不然的话它们会叠在一起"）：每帧两两分离，重叠就各退一半。
 */
describe('单位碰撞：脚下的小圆圈（P-047）', () => {
  /** 把 n 个兵钉在同一点（分离循环对 stun 的兵也生效 —— 被顶开是物理，不是行动） */
  function stack(w: ArenaWorld, n: number): void {
    for (let i = 0; i < n; i++) {
      w.units.push({
        id: 9500 + i,
        side: i % 2 === 0 ? 'blue' : 'red',
        defId: 'knight',
        x: 12, z: 10,
        hp: 100, maxHp: 100,
        cooldown: 0, stun: 999, order: null, detour: 1,
      });
    }
  }

  function minPairDist(w: ArenaWorld): number {
    let min = Number.POSITIVE_INFINITY;
    const us = w.units.filter((u) => u.hp > 0);
    for (let i = 0; i < us.length; i++) {
      for (let j = i + 1; j < us.length; j++) {
        min = Math.min(min, Math.hypot(us[i]!.x - us[j]!.x, us[i]!.z - us[j]!.z));
      }
    }
    return min;
  }

  it('叠在一起的两个兵会被掰开：间距回到 2×半径', () => {
    const w = new ArenaWorld({ seed: 201 });
    w.auto.red = false;
    stack(w, 2);
    expect(minPairDist(w), '前置：确实叠着').toBeLessThan(UNIT.radius * 2);
    run(w, 0.6);
    expect(minPairDist(w)).toBeGreaterThanOrEqual(UNIT.radius * 2 - 1e-6);
  });

  it('一坨 12 个兵也摊得开：2 秒后两两间距都 ≥ 2×半径（收敛性锁）', () => {
    const w = new ArenaWorld({ seed: 202 });
    w.auto.red = false;
    stack(w, 12);
    run(w, 2);
    expect(minPairDist(w)).toBeGreaterThanOrEqual(UNIT.radius * 2 - 1e-6);
    // 都还在场内（分离循环把越界的按回来）
    for (const u of w.units) {
      expect(u.x).toBeGreaterThanOrEqual(0.4);
      expect(u.x).toBeLessThanOrEqual(FIELD.cols - 0.4);
    }
  });

  it('间距 > 2×半径的正常对砍不受影响（近战射程 1.3 远大于碰撞直径 0.44）', () => {
    const w = new ArenaWorld({ seed: 203 });
    w.auto.red = false;
    // 沿用「两个敌对兵贴在一起会互相掉血」的几何：互砍距离 ~0.8
    give(w, 'archers');
    w.playCard('blue', 0, 12, 7);
    const blue = w.units.find((u) => u.side === 'blue')!;
    w.units.push({
      id: 9999, side: 'red', defId: 'archer', x: blue.x, z: blue.z - 0.8,
      hp: 26, maxHp: 26, cooldown: 0, stun: 0, order: null, detour: 1,
    });
    const red = w.units.find((u) => u.id === 9999)!;
    run(w, 2);
    expect(blue.hp).toBeLessThan(blue.maxHp);
    expect(red.hp).toBeLessThan(red.maxHp);
  });
});

/**
 * 主动朝向（2026-11-06 用户："弩车和移动炮没把头对准敌人"、
 * "两个军队背对背开打……应该就是主动控制他们朝向的问题"）。
 * 逻辑层 `ArenaUnit.aim`：锁敌时对准目标、行军时朝行进方向；视图统一读它。
 */
describe('朝向：锁敌转身、行军朝前（P-048）', () => {
  it('敌兵从背后压上来：蓝兵锁敌后转身朝左（≈π），红兵朝右（≈0）—— 不再背对背', () => {
    const w = new ArenaWorld({ seed: 211 });
    w.auto.red = false;
    w.units.push({ id: 9601, side: 'blue', defId: 'knight', x: 12, z: 10, hp: 100, maxHp: 100, cooldown: 0, stun: 0, order: null, detour: 1, aim: 0 });
    w.units.push({ id: 9602, side: 'red', defId: 'archer', x: 11, z: 10, hp: 100, maxHp: 100, cooldown: 0, stun: 0, order: null, detour: 1, aim: Math.PI });
    run(w, 0.5);
    const blue = w.units.find((u) => u.id === 9601)!;
    const red = w.units.find((u) => u.id === 9602)!;
    expect(Math.cos(blue.aim!), '蓝兵应当转身面向左侧的敌人').toBeLessThan(-0.5);
    expect(Math.cos(red.aim!), '红兵应当面向右侧的蓝兵').toBeGreaterThan(0.5);
  });

  it('移动弩箭（只打兵）停下开火时炮口对准背后的敌人', () => {
    const w = new ArenaWorld({ seed: 212 });
    w.auto.red = false;
    w.units.push({ id: 9603, side: 'blue', defId: 'ballista', x: 20, z: 10, hp: 70, maxHp: 70, cooldown: 0, stun: 0, order: null, detour: 1, aim: 0 });
    w.units.push({ id: 9604, side: 'red', defId: 'knight', x: 16.5, z: 10, hp: 200, maxHp: 200, cooldown: 0, stun: 999, order: null, detour: 1 });
    run(w, 0.5);
    const ballista = w.units.find((u) => u.id === 9603)!;
    expect(Math.cos(ballista.aim!), '弩车该把弩臂转朝左').toBeLessThan(-0.5);
  });

  it('反证：没敌人时行军朝向仍是"朝对面推进"（蓝≈0、红≈π）', () => {
    const w = new ArenaWorld({ seed: 213 });
    w.auto.red = false;
    w.units.push({ id: 9605, side: 'blue', defId: 'knight', x: 12, z: 10, hp: 100, maxHp: 100, cooldown: 0, stun: 0, order: null, detour: 1 });
    w.units.push({ id: 9606, side: 'red', defId: 'knight', x: 34, z: 10, hp: 100, maxHp: 100, cooldown: 0, stun: 999, order: null, detour: 1 });
    run(w, 0.5);
    expect(Math.cos(w.units.find((u) => u.id === 9605)!.aim!)).toBeGreaterThan(0.9);
  });
});

/**
 * 拖放影子的判据（2026-11-06）：canPlaceAt 只校验、不落牌，
 * 与 playCard 共用同一份 placementProblem，影子的绿/红才不会骗人。
 */
describe('拖放影子：canPlaceAt（P-048）', () => {
  it('合法格 → ok 且世界状态一点不变（不扣钱、不进冷却、不出兵）', () => {
    const w = new ArenaWorld({ seed: 221 });
    w.auto.red = false;
    give(w, 'house');
    const gold = w.gold.blue;
    const n = w.units.length;
    expect(w.canPlaceAt('blue', 0, 6, 8)).toEqual({ ok: true });
    expect(w.gold.blue).toBe(gold);
    expect(w.handCooldown[0]).toBe(0);
    expect(w.units.length).toBe(n);
  });

  it('黄区 → 拒绝并给理由；和 playCard 的拒绝理由一字不差', () => {
    const w = new ArenaWorld({ seed: 222 });
    w.auto.red = false;
    give(w, 'house');
    const probe = w.canPlaceAt('blue', 0, FIELD.midCol - 1, 8);
    const real = w.playCard('blue', 0, FIELD.midCol - 1, 8);
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain('黄区');
    expect(real.reason).toBe(probe.reason);
  });

  it('反证：影子说 ok 的格子，playCard 一定落得下去', () => {
    const w = new ArenaWorld({ seed: 223 });
    w.auto.red = false;
    give(w, 'house');
    expect(w.canPlaceAt('blue', 0, 6, 6).ok).toBe(true);
    expect(w.playCard('blue', 0, 6, 6).ok).toBe(true);
  });
});
