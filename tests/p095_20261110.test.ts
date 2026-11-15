/**
 * P-095 锁（2026-11-10）：卡面 SVG 概率性消失、建筑模型改型、兽人巢穴自动出兵。
 *
 * 用户原话三条：
 * ① 「有的那个 SVG 有概率不显示。这个串台了，有的建筑是大地图专属，不过你带过来也行」
 * ② 「齿轮工厂顶是钝角顶、整个建筑稍微矮一点。侧面的齿轮当然不动它」
 *    「兵营希望变成平顶的，有墙垛」「兽人巢穴上面那两个角太细了，希望是真正的羊角建模」
 * ③ 「兽人巢穴应该也自动出一个普通兽人兵，和这个军营一样」
 *
 * 三层分开验：① 缓存 bug 的装配锁 + 图标覆盖；② 模型零件级锁（含"齿轮一件没动"）；
 * ③ 自动出兵的端到端读数（含 48 局平衡台账回归，见 balance_20261107）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { BARRACKS, CARDS, ORC_LAIR, SUPPLY } from '@arena/config';
import { CARD_ICON, iconOf } from '@arena/cardIcons';
import { ARENA_FLAGS, ARENA_MODELS, ARENA_PAL } from '@arena/models';
import { SIDE_COLOR } from '@arena/theme';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const BLUE = SIDE_COLOR.blue;
type BoxPart = { kind: 'box'; size: readonly [number, number, number] };
const boxSize = (n: { part: unknown }): readonly [number, number, number] | null =>
  (n.part as BoxPart).kind === 'box' ? (n.part as BoxPart).size : null;

function run(w: ArenaWorld, seconds: number): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) w.update(0.05);
}

// ---------------------------------------------------------------- ① 图标

describe('① 卡面 SVG 不再「有概率不显示」', () => {
  it('病根装配锁：清空 art 时必须同时清掉 data-icon 缓存', () => {
    const hud = read('src/arena/ArenaHud.ts');
    // 两处清空（飞出动画结束 / 空白格）都得清缓存，漏一处就会复现
    expect(hud).toContain('delete el.dataset[\'icon\']');
    expect(hud.match(/delete el\.dataset\['icon'\]/g)).toHaveLength(2);
    // 重建判断必须同时看 id 和 DOM 里是不是真的还有 SVG
    expect(hud).toContain("el.dataset['icon'] !== card.id || parts.art.childElementCount === 0");
    // 主 HUD 支持扩展卡自带的 icon（大地图专属卡串台进来也不是空框）
    expect(hud).toContain('card.icon ?? iconOf(card.id)');
    expect(read('src/arena/config.ts')).toContain('icon?: string;');
  });

  it('主模式卡池每一张都有真图标，扩展卡也都自带 icon（不靠兜底空框）', () => {
    for (const card of CARDS) {
      expect(CARD_ICON[card.id], `${card.id} 没注册卡面图标`).toBeTruthy();
      expect(iconOf(card.id)).not.toContain('stroke-dasharray');
    }
    const hand = read('public/mods/grand-map/core/hand.js');
    expect(hand).toContain('const MARKET_ICON');
    expect(hand).toContain('const CARAVAN_ICON');
    expect(hand).toContain('const ESCORT_ICON');
    expect(hand).toContain('icon: MARKET_ICON');
    expect(hand).toContain('icon: CARAVAN_ICON');
    expect(hand).toContain('icon: ESCORT_ICON');
  });
});

// ---------------------------------------------------------------- ② 模型

describe('② 建筑剪影：平顶墙垛 / 钝角矮工厂 / 真羊角 / 精致商行', () => {
  it('兵营：没有双坡 prism，改成灰石平顶 + 8 座带阵营色的城垛', () => {
    const m = ARENA_MODELS.barracks(BLUE);
    expect(m.static.some((n) => n.part.kind === 'prism'), '双坡顶不许回来').toBe(false);
    const roof = m.static.find((n) => {
      const s = boxSize(n);
      return s && s[0] === 1.6 && s[1] === 0.12;
    });
    expect(roof, '平屋面').toBeTruthy();
    const cap = m.static.find((n) => {
      const s = boxSize(n);
      return s && s[0] === 1.66 && s[1] === 0.1;
    });
    expect(cap?.color, '压顶必须是灰石平台，不是一整块黑瓦').toBe(ARENA_PAL.stone);
    const merlons = m.static.filter((n) => {
      const s = boxSize(n);
      return s && s[1] === 0.17;
    });
    expect(merlons, '八座城垛').toHaveLength(8);
    expect(merlons.every((n) => n.color !== ARENA_PAL.wall), '城垛要带阵营色').toBe(true);
    expect(ARENA_FLAGS.barracks.base, '旗跟着平顶降下来').toBeLessThan(2.9);
  });

  it('齿轮工厂：缓坡钝顶 + 压矮，但侧面齿轮与双烟囱一件没动', () => {
    const m = ARENA_MODELS.gearFactory(BLUE);
    const roof = m.static.find((n) => n.part.kind === 'prism');
    expect(roof, '屋顶还在').toBeTruthy();
    // 脊高 0.32 → 0.14：半跨 0.85 ⇒ 脊角约 161°，是钝角不是尖人字顶
    expect((roof!.part as { size: readonly [number, number, number] }).size[1]).toBe(0.14);
    const ridge = m.static.find((n) => {
      const s = boxSize(n);
      return s && s[0] === 1.74 && s[1] === 0.06;
    });
    expect((ridge!.part as BoxPart).size[2], '钝脊压顶加宽').toBeGreaterThanOrEqual(0.3);
    // 齿轮：28 件会动、两枚轮心坐标原样
    const moving = m.static.filter((n) => n.spin !== undefined);
    expect(moving, '齿轮件数').toHaveLength(28);
    expect(moving.some((n) => n.at && Math.abs(n.at[0] + 0.3) < 1e-9 && Math.abs(n.at[2] - 0.56) < 1e-9)).toBe(true);
    expect(moving.some((n) => n.at && Math.abs(n.at[0] - 0.16) < 1e-9 && Math.abs(n.at[2] - 0.56) < 1e-9)).toBe(true);
    // 两根烟囱还在
    expect(m.static.filter((n) => n.part.kind === 'cyl' &&
      (n.part as { rTop: number }).rTop === 0.085)).toHaveLength(2);
    expect(ARENA_FLAGS.gearFactory.base, '旗跟着矮屋顶降下来').toBeLessThan(3.1);
  });

  it('兽人巢穴：不再是两根 0.06 宽的细棍，而是 ≥10 段渐细带转角的弯羊角', () => {
    const m = ARENA_MODELS.orcLair(BLUE);
    const oldSpikes = m.static.filter((n) => {
      const s = boxSize(n);
      return s && s[0] === 0.06 && s[1] >= 0.38;
    });
    expect(oldSpikes, '旧细骨刺').toHaveLength(0);
    const hornSegs = m.static.filter((n) =>
      n.part.kind === 'cyl' && n.rot && Math.abs(n.rot[2]) > 1e-6 &&
      (n.part as { rTop: number; rBottom: number }).rTop !== (n.part as { rTop: number; rBottom: number }).rBottom);
    expect(hornSegs.length, '每侧 5 段 × 2').toBeGreaterThanOrEqual(10);
    // 同一侧按弯角排序后半径必须单调变细，才是"角"不是"一串珠子"
    for (const side of [-1, 1]) {
      const segs = hornSegs
        .filter((n) => Math.sign(n.rot![2]!) === -side)
        .sort((a, b) => Math.abs(a.rot![2]!) - Math.abs(b.rot![2]!));
      expect(segs.length).toBe(5);
      for (let i = 1; i < segs.length; i++) {
        const prev = (segs[i - 1]!.part as { rTop: number }).rTop;
        const cur = (segs[i]!.part as { rTop: number }).rTop;
        expect(cur, `第 ${i} 段要更细`).toBeLessThan(prev);
      }
    }
  });

  it('商行：比民居多出匾额 / 斜布篷 / 门柱 / 货箱，不再只是贴一块金砖', () => {
    const g = ARENA_MODELS.guild(BLUE);
    const h = ARENA_MODELS.house(BLUE);
    expect(g.static.length).toBeGreaterThanOrEqual(h.static.length + 6);
    expect(g.static.some((n) => n.rot && Math.abs(n.rot[0]) > 0.1), '斜撑布篷').toBe(true);
    expect(g.static.filter((n) => n.color === ARENA_PAL.gold).length, '金框匾额').toBeGreaterThanOrEqual(1);
    expect(g.shell).toEqual(h.shell); // 可掉落外壳仍复用民居
  });
});

// ---------------------------------------------------------------- ③ 自动出兵

describe('③ 兽人巢穴自动出普通兽人兵（和兵营一样）', () => {
  const lair = (seed = 951) => {
    const w = new ArenaWorld({ seed });
    w.auto.red = false;
    const b = w['place']('blue', 'orcLair', 6, 4, 520);
    b.build = 1; // 完工才出兵
    return w;
  };

  it('无民居 / 无磨坊也照出：每 BARRACKS.interval 秒吐 1 个普通 orc', () => {
    const w = lair();
    // 全场只有双方大本营 + 这一座巢穴：一栋后勤楼都没有，照样出兵
    expect([...w.buildings.values()].filter((b) => b.kind !== 'core').map((b) => b.kind))
      .toEqual(['orcLair']);
    run(w, BARRACKS.interval + 0.2);
    const units = w.units.filter((u) => u.side === 'blue');
    expect(units).toHaveLength(1);
    expect(units[0]!.defId).toBe('orc');       // 普通兽人，不是投矛手
    expect(units[0]!.fromBarracks).toBe(true); // 不借闲置人口
    expect(w.supplyOf('blue').debt).toBe(0);
    expect(units[0]!.breadCost).toBe(ORC_LAIR.breadPerMan);
    expect(w.supplyOf('blue').bread).toBe(ORC_LAIR.breadPerMan * SUPPLY.unitBread);
  });

  it('节拍 / 上限都跟兵营同源：没到点不出、满 6 个不再出', () => {
    const w = lair(952);
    run(w, BARRACKS.interval - 0.2);
    expect(w.units.filter((u) => u.side === 'blue')).toHaveLength(0);
    run(w, 0.4);
    expect(w.units.filter((u) => u.side === 'blue')).toHaveLength(1);

    const full = lair(953);
    for (let i = 0; i < BARRACKS.cap; i++) {
      full.units.push({
        id: 9600 + i, side: 'blue', defId: 'orc', x: 10 + i, z: 12,
        hp: 60, maxHp: 60, cooldown: 0, stun: 0, order: null, detour: 1,
      });
    }
    run(full, BARRACKS.interval + 0.2);
    expect(full.units.filter((u) => u.side === 'blue')).toHaveLength(BARRACKS.cap);
  });

  it('口粮是兵营的 1 份，不是卡牌兽人的双份（双份会把拆楼台账压到 1.94 栋/局）', () => {
    expect(ORC_LAIR.breadPerMan).toBe(1);
    const src = read('src/arena/config.ts');
    expect(src).toContain('export const ORC_LAIR = { hp: 520, cost: 12, breadPerMan: 1 }');
    expect(read('src/arena/ArenaWorld.ts')).toContain('白送的守兵和花牌买的兽人军队不是一回事');
  });
});
