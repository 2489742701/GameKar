/**
 * P-094 结算账单锁（2026-11-09，用户原话）：
 * 「这个结算积分搞得更清楚一点，左右两边就像有个账单一样，
 *  显示销毁了哪些建筑，为什么积分更多。」
 *
 * 三层分开验：
 * ① **数据层**：`hurtBuilding()` 是拆楼账本的唯一写入口，`destroyLog`
 *    记全「谁被拆 / 谁动的手 / 拆了什么 / 第几秒」；
 * ② **账单层**：左右两栏列拆掉/丢失的建筑明细，三级判据逐行摊开，
 *    `decided` 必须指向 `finish()` 当时记下的那一级（不许事后重算）；
 * ③ **UI 层**：结算面板真的摆出左右两栏 + 高亮决定项。
 *
 * 反证的重点是「左右不能写反」：蓝方拆掉的 == 红方丢掉的，
 * 把 `by` / `owner` 搞混这条立刻红 —— 这正是结算页最容易骗人的错。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld, type ArenaBuilding } from '@arena/ArenaWorld';
import { BUILDING_LABEL, BUILDING_SPECS, CORE, type Side } from '@arena/config';
import { buildingLabelOf } from '@arena/config';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function world(seed = 960): ArenaWorld {
  const w = new ArenaWorld({ seed });
  w.auto.red = false;
  return w;
}

/** 造一栋楼再当场拆掉（走真实 hurtBuilding，账本会记一条）。 */
function wreck(w: ArenaWorld, owner: Side, kind: keyof typeof BUILDING_SPECS, col: number, by: Side): ArenaBuilding {
  const b = w['place'](owner, kind, col, 4, 500);
  b.build = 1;
  w['hurtBuilding'](b, 99999, 'blade', by);
  return b;
}

/** 直接把世界拨到结算态（判据已在 checkOutcome 里单测，这里只验账单怎么摆）。 */
function finish(
  w: ArenaWorld,
  decider: 'core' | 'alive' | 'coreHp' | 'destroyed' | 'draw',
  outcome: 'win' | 'lose' | 'draw' = 'win',
) {
  w['finish'](outcome, decider === 'core' ? 'core' : decider === 'draw' ? 'draw' : 'overtime', decider);
  return w.summary().ledger!;
}

describe('① 拆楼账本：唯一写入口、字段不缺', () => {
  it('对局中 ledger 是 null（20Hz 零开销）；结算后只算一次并缓存', () => {
    const w = world();
    expect(w.summary().ledger).toBeNull();
    wreck(w, 'red', 'arrowTower', 30, 'blue');
    w['finish']('win', 'overtime', 'alive');
    const a = w.summary().ledger;
    expect(a).not.toBeNull();
    expect(w.summary().ledger).toBe(a); // 同一份对象，不是每帧重建
  });

  it('拆一栋红方箭塔：owner=red / by=blue / 种类 / 时刻 / 坐标都记全', () => {
    const w = world(961);
    w.update(0.05); // 让 elapsed 不是 0，验 at 真的取了时间
    wreck(w, 'red', 'arrowTower', 30, 'blue');
    expect(w.destroyLog).toHaveLength(1);
    expect(w.destroyLog[0]).toMatchObject({
      kind: 'arrowTower', owner: 'red', by: 'blue', col: 30, row: 4,
    });
    expect(w.destroyLog[0]!.at).toBeGreaterThan(0);
    expect(w.destroyed.red).toBe(1);
    expect(w.destroyed.blue).toBe(0);
  });

  it('大本营也叫一栋楼，中文名是「大本营」，账单不把它吞掉', () => {
    const w = world(962);
    const core = w['coreOf']('red')!;
    w['hurtBuilding'](core, CORE.hp * 2, 'cannon', 'blue');
    const L = finish(w, 'core');
    expect(L.blue.wrecked.some((x) => x.name === '大本营')).toBe(true);
    expect(buildingLabelOf('core')).toBe('大本营');
  });

  it('同名楼聚合成一行，count / firstAt / lastAt 跟着更新', () => {
    const w = world(963);
    wreck(w, 'red', 'house', 30, 'blue');
    w.update(0.05);
    for (let i = 0; i < 20; i++) w.update(0.05); // 推进 1 秒
    wreck(w, 'red', 'house', 34, 'blue');
    wreck(w, 'red', 'mill', 38, 'blue');
    const L = finish(w, 'destroyed');
    expect(L.blue.wrecked).toHaveLength(2); // 民居 / 磨坊各一行
    const houses = L.blue.wrecked.find((x) => x.kind === 'house')!;
    expect(houses.count).toBe(2);
    expect(houses.lastAt).toBeGreaterThan(houses.firstAt);
    expect(L.blue.wreckedTotal).toBe(3);
  });
});

describe('② 左右账单：拆了什么、丢什么、为什么积分更多', () => {
  it('反证：蓝方拆掉的 == 红方丢掉的（by / owner 写反会红）', () => {
    const w = world(964);
    wreck(w, 'red', 'arrowTower', 30, 'blue');
    wreck(w, 'red', 'house', 34, 'blue');
    wreck(w, 'blue', 'mill', 6, 'red');
    const L = finish(w, 'destroyed');
    expect(L.blue.wreckedTotal).toBe(2);
    expect(L.red.lostTotal).toBe(2);
    expect(L.red.wreckedTotal).toBe(1);
    expect(L.blue.lostTotal).toBe(1);
    expect(L.blue.wreckedTotal).toBe(w.destroyed.red);
    expect(L.red.wreckedTotal).toBe(w.destroyed.blue);
  });

  it('明细是中文名，读的是 BUILDING_LABEL 那张表', () => {
    const w = world(965);
    wreck(w, 'red', 'guild', 30, 'blue');
    const L = finish(w, 'alive');
    expect(L.blue.wrecked[0]!.name).toBe(BUILDING_LABEL.guild);
    expect(L.red.lost[0]!.name).toBe('商行');
  });

  it('三级判据顺序固定：存活建筑 → 大本营剩血 → 拆掉对方', () => {
    const w = world(966);
    wreck(w, 'red', 'house', 30, 'blue');
    const L = finish(w, 'coreHp');
    expect(L.criteria.map((c) => c.key)).toEqual(['alive', 'coreHp', 'destroyed']);
    expect(L.criteria.map((c) => c.decided)).toEqual([false, true, false]);
    expect(L.criteria[1]!.blue).toBe(1200);
    expect(L.criteria[1]!.red).toBe(1200);
    expect(L.headline).toContain('大本营剩血');
    expect(L.headline).toContain('胜负就停在这一级');
  });

  it('决定项随判定走：alive / destroyed / draw / core 各标各的', () => {
    const alive = finish(world(967), 'alive');
    expect(alive.criteria.map((c) => c.decided)).toEqual([true, false, false]);
    expect(alive.decidedBy).toBe('alive');

    const destroyed = finish(world(968), 'destroyed');
    expect(destroyed.criteria.map((c) => c.decided)).toEqual([false, false, true]);

    // 反证：拆家结束根本不比三级积分，账单不许自己挑一项标成「决定胜负」
    const core = finish(world(969), 'core');
    expect(core.criteria.every((c) => !c.decided)).toBe(true);
    expect(core.headline).toContain('直接结束');

    const draw = finish(world(970), 'draw', 'draw');
    expect(draw.criteria.every((c) => !c.decided)).toBe(true);
    expect(draw.headline).toContain('平局');
  });

  it('终局读数：alive 只数非大本营楼，coreHp 取真实剩血', () => {
    const w = world(971);
    const b = w['place']('blue', 'house', 6, 4, 220);
    b.build = 1;
    wreck(w, 'red', 'house', 30, 'blue');
    const L = finish(w, 'alive');
    expect(L.blue.alive).toBe(1);
    expect(L.red.alive).toBe(0);
    expect(L.blue.coreHp).toBe(1200);
    expect(L.red.coreHp).toBe(1200);
  });
});

describe('③ 装配点：HUD 真的把账单摆成左右两栏', () => {
  it('DOM / CSS / 结构锁', () => {
    const hud = read('src/arena/ArenaHud.ts');
    const css = read('src/styles/arena.css');
    const worldSrc = read('src/arena/ArenaWorld.ts');
    const types = read('src/arena/types.ts');
    expect(hud).toContain('this.paintLedger(s)');
    expect(hud).toContain('ahud__ledger__col');
    expect(hud).toContain('data-decided');
    expect(hud).toContain("this.end.append(make('div', 'ahud__end__title', ''), this.endSub, this.endLedger, endBtns)");
    // 中央「加时赛 / 第 N 波」大字会挂 2.7 秒，结算时必须收掉，否则压在两栏中间
    expect(hud).toContain("this.big.dataset['show'] = '0'");
    expect(css).toContain('.ahud__ledger__cols');
    expect(css).toContain('.ahud__ledger__row[data-decided=');
    expect(types).toContain('export interface DestroyRecord');
    expect(worldSrc).toContain('this.destroyLog.push({');
    expect(worldSrc).toContain('ledger: this.ledger');
  });

  it('拆楼伤害两处调用都把「谁动的手」传进去了', () => {
    const worldSrc = read('src/arena/ArenaWorld.ts');
    const calls = worldSrc.match(/this\.hurtBuilding\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(worldSrc).toContain("b.kind === 'arrowTower' ? 'arrow' : 'cannon', b.side)");
    expect(worldSrc).toContain('this.hurtBuilding(foe.building, st.damage, hit, u.side)');
  });

  it('结算第二行不再把四组数字挤成一行，改指向账单', () => {
    const hud = read('src/arena/ArenaHud.ts');
    expect(hud).toContain('详细账单见下');
    expect(hud).not.toContain('积分（存活楼） 你');
  });

  it('标题按 reason 分：积分赢的不许说成「大本营被拆了」', () => {
    const hud = read('src/arena/ArenaHud.ts');
    expect(hud).toContain("s.reason === 'core'");
    expect(hud).toContain('加时积分胜出 —— 你赢了');
    expect(hud).toContain('加时积分落后 —— 这局输了');
    expect(hud).toContain('红方大本营被拆了 —— 你赢了');
  });
});
