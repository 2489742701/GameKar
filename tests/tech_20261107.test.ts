/**
 * 2026-11-07 设计文档 A/B/C 节的锁：科技前置 / 民兵集结 / 齿轮工厂 4×3。
 */
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { BUILDING_SPECS, CARDS, FIELD, TECH, cardById } from '@arena/config';

function run(w: ArenaWorld, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / 0.05); i++) w.update(0.05);
}

function built(w: ArenaWorld, kind: 'barracks' | 'gearFactory' | 'orcLair', col = 6, row = 6) {
  const b = w['place']('blue', kind, col, row, 9999);
  b.build = 1;
  return b;
}

function handIds(w: ArenaWorld): string[] {
  return w.hands.blue.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => c.id);
}

/** 多次刷新收集出现过的卡（抽卡有随机性，用覆盖面断言而不是赌某一手）。 */
function seenAfterRerolls(w: ArenaWorld, times = 12): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < times; i++) {
    w.gold.blue = 20;
    w.reroll('blue');
    for (const id of handIds(w)) seen.add(id);
  }
  return seen;
}

describe('民兵集结（设计文档 B 节）', () => {
  it('4 民兵 + 2 弓箭手 = 6 人、5 金、每人半份面包', () => {
    const card = cardById(TECH.militia);
    expect(card.cost).toBe(5);
    expect(card.squad).toEqual([{ unitId: 'militia', count: 4 }, { unitId: 'archer', count: 2 }]);
    expect((card.squad ?? []).reduce((n, g) => n + g.count, 0)).toBe(6);
    expect(card.breadPerMan).toBe(0.5);
  });

  it('开局就能出：0 人口 + 3 面包正好压满基础容器（2026-11-07 民兵改成不占人口）', () => {
    const w = new ArenaWorld({ seed: 301 });
    w.auto.red = false;
    w.gold.blue = 20;
    w.hands.blue[0] = cardById(TECH.militia);
    w.handCooldowns.blue[0] = 0;
    expect(w.playCard('blue', 0, 6, 9).ok).toBe(true);
    const s = w.supplyOf('blue');
    expect(w.units.filter((u) => u.side === 'blue')).toHaveLength(6);
    expect(s.pop).toBe(0);
    expect(s.bread).toBe(3);
    expect(s.breadMax).toBe(3);
    // 每个兵都记了半份口粮与零人口（兵营兵不受影响）
    expect(w.units.every((u) => u.side !== 'blue' || u.breadCost === 0.5)).toBe(true);
    expect(w.units.every((u) => u.side !== 'blue' || u.popCost === 0)).toBe(true);
  });
});

describe('科技前置：默认 / 兵营 / 工厂（设计文档 A 节）', () => {
  it('默认：刷新 12 次也只会出现民兵这一种军队卡', () => {
    const w = new ArenaWorld({ seed: 302 });
    const seen = seenAfterRerolls(w);
    const army = [...seen].filter((id) => cardById(id)?.kind !== 'building');
    expect(army).toEqual([TECH.militia]);
    expect(w.techHint('blue')).toBe('需要军营解锁军队');
  });

  it('盖好兵营：地面军队解锁，飞行器仍然不出现', () => {
    const w = new ArenaWorld({ seed: 303 });
    const b = built(w, 'barracks');
    expect(w.hasBuilt('blue', 'barracks')).toBe(true);
    const seen = seenAfterRerolls(w);
    expect([...seen].some((id) => ['archers', 'knights', 'spearmen'].includes(id))).toBe(true);
    for (const id of TECH.factoryCards) expect(seen.has(id)).toBe(false);
    expect(w.techHint('blue')).toBe('需要齿轮工厂解锁空军与攻城车');
    // 拆掉兵营 ⇒ 立刻重新上锁
    w.buildings.delete(b.id);
    expect(w.hasBuilt('blue', 'barracks')).toBe(false);
    expect(handIds(w).some((id) => id !== TECH.militia && cardById(id)?.kind !== 'building')).toBe(false);
  });

  it('盖好齿轮工厂：三架飞行器进池', () => {
    const w = new ArenaWorld({ seed: 304 });
    built(w, 'barracks', 6, 6);
    built(w, 'gearFactory', 10, 6);
    expect(w.hasBuilt('blue', 'gearFactory')).toBe(true);
    // 判据锁：三架都解锁（不赌抽卡运气）
    for (const id of TECH.factoryCards) {
      expect(w.techAllows('blue', cardById(id)), `${id} 前置应满足`).toBe(true);
    }
    // 统计锁：刷新多轮至少出现过一架（保底会占手牌格，别断言每张都出现）
    const seen = seenAfterRerolls(w, 30);
    expect(TECH.factoryCards.some((id) => seen.has(id))).toBe(true);
    // 2026-11-07 又加了兽人巢穴这一级解锁：工厂建好只走到"该盖巢穴了"
    expect(w.techHint('blue')).toBe('需要兽人巢穴解锁兽人军队');
    built(w, 'orcLair', 14, 10);
    expect(w.techHint('blue')).toBeNull();
  });

  it('施工中的科技建筑不算解锁（build<1 不干活）', () => {
    const w = new ArenaWorld({ seed: 305 });
    const b = w['place']('blue', 'barracks', 6, 6, 420);
    b.build = 0.5;
    expect(w.hasBuilt('blue', 'barracks')).toBe(false);
    expect(w.techAllows('blue', cardById('archers'))).toBe(false);
  });
});

/**
 * 2026-11-07 用户："如果场上有一个工业工厂，玩家不会再被发到这个手牌，
 * 除非自己的工厂被摧毁。"
 *
 * 判据只有一处：`ArenaWorld.techAllows` → `hasFactory`。抽卡、刷新、补牌、
 * 拆楼后的换牌全都经过它，所以这里不需要在每个入口各测一遍。
 */
describe('唯一建筑：自家齿轮工厂占坑时退出卡池', () => {
  const factoryCard = cardById('gearFactory');

  it('没有工厂：判据放行，反复刷新能抽到工厂卡', () => {
    const w = new ArenaWorld({ seed: 331 });
    expect(w.hasFactory('blue')).toBe(false);
    expect(w.techAllows('blue', factoryCard)).toBe(true);
    expect(seenAfterRerolls(w, 30).has('gearFactory')).toBe(true);
  });

  it('工厂一落地（连施工中）就禁发：判据关掉 + 30 轮刷新零命中', () => {
    const w = new ArenaWorld({ seed: 332 });
    const b = w['place']('blue', 'gearFactory', 10, 6, 700);
    b.build = 0.4; // 故意施工中不完工：占坑这件事跟完不完工无关
    expect(w.hasFactory('blue')).toBe(true);
    expect(w.techAllows('blue', factoryCard)).toBe(false);
    const seen = seenAfterRerolls(w, 30);
    expect(seen.has('gearFactory')).toBe(false);
  });

  it('出了工厂卡之后，补牌不会把第二张工厂卡塞回来', () => {
    const w = new ArenaWorld({ seed: 333 });
    w.auto.red = false;
    w.gold.blue = 20;
    w.hands.blue.fill(null);
    w.hands.blue[0] = factoryCard;
    w.handCooldowns.blue[0] = 0;
    expect(w.playCard('blue', 0, 6, 9).ok).toBe(true);
    expect(w.hasFactory('blue')).toBe(true);
    // 跑够冷却补齐四格，任何一格都不许再出现工厂卡
    for (let i = 0; i < 400; i++) w.update(0.05);
    for (const c of w.hands.blue) expect(c?.id).not.toBe('gearFactory');
  });

  it('工厂被摧毁 ⇒ 自动恢复发牌（废墟不算楼）', () => {
    const w = new ArenaWorld({ seed: 334 });
    const b = built(w, 'gearFactory', 10, 6);
    expect(w.techAllows('blue', factoryCard)).toBe(false);
    w.buildings.delete(b.id); // hurtBuilding 打空血走的就是这一句
    w.ruins.push({ id: 9999, kind: 'gearFactory', side: 'blue', col: 10, row: 6, cols: 4, rows: 3, ttl: 10, total: 10 });
    expect(w.hasFactory('blue')).toBe(false);
    expect(w.techAllows('blue', factoryCard)).toBe(true);
    expect(seenAfterRerolls(w, 30).has('gearFactory')).toBe(true);
  });

  it('只锁自家：对面红方照常能拿工厂卡', () => {
    const w = new ArenaWorld({ seed: 335 });
    built(w, 'gearFactory', 10, 6);
    expect(w.techAllows('blue', factoryCard)).toBe(false);
    expect(w.techAllows('red', factoryCard)).toBe(true);
  });

  it('PVE 双人同阵营：一人建厂，两个人的手牌都不再发工厂卡', () => {
    const w = new ArenaWorld({ seed: 336, mode: 'pve', players: 2 });
    built(w, 'gearFactory', 10, 6);
    expect(w.seatCount).toBe(2);
    for (const p of w.players) {
      p.gold = 20;
      for (let i = 0; i < 20; i++) w.rerollOf(p);
      for (const c of p.hand) expect(c?.id, `玩家 ${p.id} 拿到工厂卡`).not.toBe('gearFactory');
    }
  });
});

describe('齿轮工厂 4×3（设计文档 C 节）', () => {
  it('规格是 4 列 3 行，是第一栋非 3×3 建筑', () => {
    expect(BUILDING_SPECS.gearFactory.cols).toBe(4);
    expect(BUILDING_SPECS.gearFactory.rows).toBe(3);
    expect(cardById('gearFactory').cost).toBe(16);
  });

  it('黄区判据遍历 4 列：压到黄区就被拒，合法位置放得下', () => {
    const w = new ArenaWorld({ seed: 306 });
    w.auto.red = false;
    w.gold.blue = 20;
    w.hands.blue[0] = cardById('gearFactory');
    w.handCooldowns.blue[0] = 0;
    // 蓝方半场 col<22；黄区 col 18..26，4 列从 15 起会压到 18
    expect(w.playCard('blue', 0, 15, 6).ok).toBe(false);
    expect(w.playCard('blue', 0, 6, 6).ok).toBe(true);
    const b = [...w.buildings.values()].find((x) => x.kind === 'gearFactory')!;
    expect(b.cols).toBe(4);
    expect(b.rows).toBe(3);
    run(w, BUILDING_SPECS.gearFactory.cols); // 施工推进：完工才算解锁
    expect(w.hasBuilt('blue', 'gearFactory')).toBe(true);
  });

  it('卡池 27 张（P-093 新增商行）；工厂不需要后勤配给', () => {
    expect(CARDS).toHaveLength(27);
    const w = new ArenaWorld({ seed: 307 });
    const b = built(w, 'gearFactory');
    expect(w.isStaffed(b.id)).toBe(true); // 被动科技，不挂「缺民居」
    void FIELD;
  });
});
