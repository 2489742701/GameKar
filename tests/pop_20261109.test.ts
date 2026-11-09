/**
 * P-094 人口三分锁（2026-11-09，用户原话）：
 * 「改成闲置人口和占用人口和全部人口。闲置人口会慢慢提回来，
 *  占用人口就是所有建筑物占用的人口是被卡死的……
 *  现在就是放置一个军队之后，闲置人口会慢慢增长。」
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ 全部 total = basePop + 民居 × housePop                        │
 * │ 占用 used  = Σ BUILDING_POP[建筑]  ← **卡死**，不随时间回      │
 * │ 闲置 idle  = total − used − debt                              │
 * │   debt = 军队卡借走的人口，每 idleRegenSeconds 秒还 1 格       │
 * │ 面包 bread = 活兵实时吃，兵死立刻退（容器，口径没变）           │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 这层锁的重点是三个**容易被偷偷改回去**的地方：
 * ① 建筑占用不许随时间恢复（卡死）；② 兵死了人口不许立刻退（面包才退）；
 * ③ 恢复是整格跳，不是连续小数（顶栏三个整数必须加得起来）。
 * 另外配两条行为反证：改常量恢复速度必须真的变、改占用判据必须红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import {
  BUILDING_LABEL, BUILDING_POP, BUILDING_SPECS, SUPPLY, cardById,
} from '@arena/config';
import { labelOf } from '@arena/visuals/labels';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function run(w: ArenaWorld, seconds: number): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) w.update(0.05);
}

/** 直接落一栋完工楼（跳过施工，锁的是规则不是动画）。 */
function built(w: ArenaWorld, kind: keyof typeof BUILDING_SPECS, col: number, row: number) {
  const b = w['place']('blue', kind, col, row, 500);
  b.build = 1;
  return b;
}

/** 把一张牌塞进第 0 格并打出去，走的是真实 execute()（会登记人口债务）。 */
function put(w: ArenaWorld, id: string, col = 6, row = 12) {
  w.hands.blue[0] = cardById(id);
  w.handCooldowns.blue[0] = 0;
  w.gold.blue = 30;
  return w.playCard('blue', 0, col, row);
}

function world(seed = 940): ArenaWorld {
  const w = new ArenaWorld({ seed });
  w.auto.red = false;
  return w;
}

describe('① 三分读数：全部 / 占用 / 闲置 加起来对得上账', () => {
  it('开局：闲置 6 / 占用 0 / 共 6，debt=0，且兼容别名 pop=used+debt', () => {
    const s = world().supplyOf('blue');
    expect(s.total).toBe(SUPPLY.basePop);
    expect(s.used).toBe(0);
    expect(s.debt).toBe(0);
    expect(s.idle).toBe(SUPPLY.basePop);
    expect(s.pop).toBe(s.used + s.debt);
    expect(s.popMax).toBe(s.total);
    expect(s.idle + s.used + s.debt).toBe(s.total);
  });

  it('盖楼：占用 +BUILDING_POP、闲置同额减少，全部不变', () => {
    const w = world(941);
    built(w, 'arrowTower', 4, 4);
    built(w, 'mill', 8, 4);
    const s = w.supplyOf('blue');
    expect(s.used).toBe(BUILDING_POP.arrowTower + BUILDING_POP.mill);
    expect(s.total).toBe(SUPPLY.basePop);
    expect(s.idle).toBe(s.total - s.used);
    expect(s.debt).toBe(0);
  });

  it('盖民居：只涨全部与闲置，占用一分不动', () => {
    const w = world(942);
    built(w, 'house', 4, 4);
    const s = w.supplyOf('blue');
    expect(s.total).toBe(SUPPLY.basePop + SUPPLY.housePop);
    expect(s.used).toBe(0);
    expect(s.idle).toBe(s.total);
  });

  it('拆掉自己的楼：占用释放、闲置回涨（卡死指的是"不随时间回"，不是拆了不还）', () => {
    const w = world(943);
    const b = built(w, 'cannonTower', 4, 4);
    const before = w.supplyOf('blue');
    expect(before.used).toBe(BUILDING_POP.cannonTower);
    w['hurtBuilding'](b, 99999, 'blade', 'red');
    const after = w.supplyOf('blue');
    expect(after.used).toBe(0);
    expect(after.idle).toBe(before.idle + BUILDING_POP.cannonTower);
    expect(after.total).toBe(before.total);
  });
});

describe('② 占用人口被卡死：不随时间自己回血', () => {
  it('盖满楼后空跑 30 秒，used / idle / total 一个都不变', () => {
    const w = world(944);
    built(w, 'arrowTower', 4, 4);
    built(w, 'barracks', 8, 4);
    const before = w.supplyOf('blue');
    run(w, 30);
    expect(w.supplyOf('blue')).toMatchObject({
      used: before.used, idle: before.idle, total: before.total, debt: 0,
    });
  });

  it('面包仍是容器：空跑 30 秒 bread / breadMax 不变', () => {
    const w = world(945);
    built(w, 'mill', 4, 4);
    const before = w.supplyOf('blue');
    run(w, 30);
    expect(w.supplyOf('blue').bread).toBe(before.bread);
    expect(w.supplyOf('blue').breadMax).toBe(before.breadMax);
  });
});

describe('③ 出兵借走闲置人口，再一格一格慢慢提回来', () => {
  it('出一张骑士小队（2 人）：debt +2、idle −2，used 一分不动', () => {
    const w = world(946);
    const before = w.supplyOf('blue');
    expect(put(w, 'knights').ok).toBe(true);
    const s = w.supplyOf('blue');
    expect(s.debt).toBe(2 * SUPPLY.unitPop);
    expect(s.used).toBe(before.used);
    expect(s.idle).toBe(before.idle - 2 * SUPPLY.unitPop);
    expect(s.bread).toBe(2 * SUPPLY.unitBread);
  });

  it('跳格恢复：差一点不还、攒够 idleRegenSeconds 才还 1 格，两格要两个周期', () => {
    const w = world(947);
    expect(put(w, 'knights').ok).toBe(true);
    expect(w.supplyOf('blue').debt).toBe(2);

    run(w, SUPPLY.idleRegenSeconds - 0.1);
    expect(w.supplyOf('blue').debt, '还没到点不许回').toBe(2);
    run(w, 0.2);
    expect(w.supplyOf('blue').debt, '到点只还 1 格').toBe(1);
    run(w, SUPPLY.idleRegenSeconds - 0.1);
    expect(w.supplyOf('blue').debt).toBe(1);
    run(w, 0.2);
    expect(w.supplyOf('blue').debt).toBe(0);

    const s = w.supplyOf('blue');
    expect(s.idle).toBe(s.total - s.used);
    expect(Number.isInteger(s.idle)).toBe(true); // 顶栏不许出现 4.7 这种数
  });

  it('兵死了：面包立刻退，人口那笔债照旧慢慢销（不立刻回）', () => {
    const w = world(948);
    expect(put(w, 'knights').ok).toBe(true);
    for (const u of w.units) if (u.side === 'blue') u.hp = 0;
    run(w, 0.2);
    const s = w.supplyOf('blue');
    expect(s.bread).toBe(0);
    expect(s.debt).toBe(2);
    expect(s.idle).toBe(s.total - s.used - 2);
  });

  it('民兵 / 兽人 popPerMan=0 ⇒ 不借人口，面包照吃（旧口径没被改坏）', () => {
    const w = world(949);
    expect(put(w, 'militia').ok).toBe(true);
    const s = w.supplyOf('blue');
    expect(s.debt).toBe(0);
    expect(s.idle).toBe(s.total);
    expect(s.bread).toBeGreaterThan(0);
  });

  it('反证：把 idleRegenSeconds 调成 100，同样的 6 秒一分都回不来', () => {
    const before = SUPPLY.idleRegenSeconds;
    try {
      SUPPLY.idleRegenSeconds = 100;
      const w = world(950);
      expect(put(w, 'knights').ok).toBe(true);
      run(w, 6);
      expect(w.supplyOf('blue').debt).toBe(2);
    } finally {
      SUPPLY.idleRegenSeconds = before;
    }
    const w2 = world(950);
    expect(put(w2, 'knights').ok).toBe(true);
    run(w2, 6);
    expect(w2.supplyOf('blue').debt, '还原常量后恢复照常').toBe(1);
  });
});

describe('④ 装配点：文案 / HUD / 中文名都从同一份数出', () => {
  it('人口不够的理由里直接摆出「闲置 / 占用 / 共」三数', () => {
    const w = world(951);
    built(w, 'cannonTower', 4, 4);
    built(w, 'cannonTower', 8, 4);
    built(w, 'cannonTower', 12, 4); // used = 6，基础人口吃满
    const s = w.supplyOf('blue');
    const reason = w.supplyBlocked('blue', cardById('arrowTower'));
    expect(reason).toContain(`闲置 ${s.idle} / 占用 ${s.used} / 共 ${s.total}`);
  });

  it('HUD 顶栏真的读 idle/used/total，CSS 有三分样式', () => {
    const hud = read('src/arena/ArenaHud.ts');
    const css = read('src/styles/arena.css');
    expect(hud).toContain('sup.idle');
    expect(hud).toContain('sup.used');
    expect(hud).toContain('sup.total');
    expect(hud).not.toContain('`${sup.pop}/${sup.popMax}`'); // 旧的二格显示不许回来
    expect(css).toContain('.ahud__supply__pop3');
    expect(css).toContain("data-part='idle'");
  });

  it('逻辑层不许再写死建筑名：中文名只有 BUILDING_LABEL 一张表', () => {
    for (const kind of Object.keys(BUILDING_SPECS)) {
      expect(BUILDING_LABEL[kind as keyof typeof BUILDING_SPECS], kind).toBeTruthy();
    }
    expect(BUILDING_LABEL.core).toBe('大本营');
    const labels = read('src/arena/visuals/labels.ts');
    expect(labels).toContain('buildingLabelOf(b.kind)');
    expect(labels).not.toContain("? '防御塔'");
  });

  it('labelOf 现在能分清箭塔 / 炮塔 / 商行（旧三元链会把塔都叫「防御塔」）', () => {
    const w = world(952);
    expect(labelOf(built(w, 'arrowTower', 4, 4))).toBe('箭塔');
    expect(labelOf(built(w, 'cannonTower', 8, 4))).toBe('炮塔');
    expect(labelOf(built(w, 'guild', 12, 4))).toBe('商行');
  });
});
