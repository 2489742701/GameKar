/**
 * P-093 经济建筑锁（2026-11-09，用户原话）：
 * 「磨坊的下面应该有一个 +1金币 的 SVG」「我们可以再加一个建筑叫商行，
 *  他会加两个金币的 SVG……但是要占用两个人口和一个房子」「磨坊改成加三个面包」。
 *
 * 用户确认的两条口径：
 *  - **图标数 = 吐金数**：磨坊 1 枚金币 / 商行 2 枚，卡面和世界逻辑都读 GOLD_INCOME；
 *  - 商行 **扣 2 人口 + 民居配套停摆**（不是「效率降低」，是没配民居就一分不产）。
 *
 * 四条线分开验：① 判据表 ② 卡池 / 卡面 / 模型 ③ 真实时间推进下的产金与停摆
 * ④ 装配点（HUD / AI / 废墟 / 后勤保底都要认得商行）。
 * ③ 是重点：只锁初始字段拦不住「盖出来却不吐金」这种接线漏。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld, type ArenaBuilding } from '@arena/ArenaWorld';
import { assess, placementBand, wishList, type AiView } from '@arena/ai';
import {
  BUILD, BUILDING_POP, BUILDING_SPECS, CARDS, ECONOMY, GOLD_INCOME, LOGISTICS, SUPPLY,
  cardById, goldIncomeOf, needsHouse,
} from '@arena/config';
import { iconOf } from '@arena/cardIcons';
import { ARENA_FLAGS, ARENA_MODELS } from '@arena/models';
import { BREAD_ICON, COIN_ICON, POP_ICON } from '@arena/supplyIcons';
import { labelOf, needsStaffing } from '@arena/visuals/labels';
import { ruinStyleOf } from '@arena/visuals/ruinView';
import { supplyRows, supplyRowsHtml } from '@arena/visuals/supplyRows';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const countIcon = (html: string, svg: string): number => html.split(svg).length - 1;

/** 真的推进时间：产金是「每 5 秒一次」，光看字段初值验不出来。 */
function run(w: ArenaWorld, seconds: number): void {
  const steps = Math.round(seconds / 0.05);
  for (let i = 0; i < steps; i++) w.update(0.05);
}

function built(w: ArenaWorld, kind: ArenaBuilding['kind'], col: number, row: number) {
  const b = w['place']('blue', kind, col, row, 500);
  b.build = 1; // 跳过施工，锁的是规则不是动画
  return b;
}

/** 同 seed、同金币、关掉红方托管 ⇒ 两个世界的「自然涨金」完全可比。 */
function scene(): ArenaWorld {
  const w = new ArenaWorld({ seed: 903 });
  w.auto.red = false;
  w.gold.blue = 10; // 别顶到 ECONOMY.cap，否则产金被吃掉
  return w;
}

const gainOver = (w: ArenaWorld): number => {
  const before = w.gold.blue;
  run(w, ECONOMY.millInterval + 0.1);
  return w.gold.blue - before;
};

describe('① 判据表：图标数 = 吐金数，只有一张表', () => {
  it('GOLD_INCOME 只有磨坊 1 / 商行 2；其它楼不产金', () => {
    expect(Object.keys(GOLD_INCOME).sort()).toEqual(['guild', 'mill']);
    expect(GOLD_INCOME.mill).toBe(1);
    expect(GOLD_INCOME.guild).toBe(2);
    expect(goldIncomeOf('mill')).toBe(1);
    expect(goldIncomeOf('guild')).toBe(2);
    expect(goldIncomeOf('house')).toBe(0);
    expect(goldIncomeOf('barracks')).toBe(0);
  });

  it('磨坊 +3 面包，商行 2 人口 + 1 民居 + 3×3 规格 + 施工更久', () => {
    expect(SUPPLY.millBread).toBe(3);
    expect(BUILDING_POP.guild).toBe(2);
    expect(LOGISTICS.guildHouse).toBe(1);
    expect(BUILDING_SPECS.guild.cols).toBe(3);
    expect(BUILDING_SPECS.guild.rows).toBe(3);
    expect(BUILDING_SPECS.guild.hp).toBeGreaterThan(0);
    expect(BUILD.seconds.guild).toBeGreaterThan(BUILD.seconds.mill);
  });

  it('needsHouse 是唯一判据：商行要配民居，磨坊/民居/工厂不要', () => {
    expect(needsHouse('guild')).toBe(true);
    expect(needsHouse('barracks')).toBe(true);
    for (const k of ['mill', 'house', 'gearFactory', 'orcLair', 'core']) {
      expect(needsHouse(k), k).toBe(false);
    }
    expect(needsStaffing('guild')).toBe(true);
    expect(needsStaffing('mill')).toBe(false);
  });

  it('装配锁：millBonus 已退场，产金与金币 SVG 都只从 GOLD_INCOME 算', () => {
    expect('millBonus' in ECONOMY).toBe(false);
    const config = read('src/arena/config.ts');
    const world = read('src/arena/ArenaWorld.ts');
    const rows = read('src/arena/visuals/supplyRows.ts');
    const labels = read('src/arena/visuals/labels.ts');
    expect(config).toContain('export const GOLD_INCOME');
    expect(world).toContain('goldIncomeOf(b.kind)');
    expect(world).not.toContain('ECONOMY.millBonus');
    expect(rows).toContain('COIN_ICON.repeat(GOLD_INCOME[kind] ?? 0)');
    expect(rows).not.toContain('COIN_ICON.repeat(2)');
    expect(labels).toContain('return needsHouse(kind)');
    // 后勤消费者不许再出现旧的硬编码三件套
    expect(world).not.toContain("b.kind === 'barracks' || b.kind === 'arrowTower' || b.kind === 'cannonTower'");
  });
});

describe('② 卡池 / 卡面 / 模型', () => {
  it('商行真的进了卡池，卡 id 不重复，卡面文案写明配套代价', () => {
    expect(CARDS).toHaveLength(33);
    // id 唯一性也读同一张表，别跟着 28 手抄（P-103 加火球术时要改两个数就漏了）
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
    const g = cardById('guild');
    expect(g.kind).toBe('building');
    expect(g.building).toBe('guild');
    expect(g.name).toBe('商行');
    expect(g.cost).toBeGreaterThan(cardById('mill').cost);
    expect(g.blurb).toContain('民居');
    expect(cardById('mill').blurb).toContain('3 面包');
  });

  it('商行的卡图标 / 3D 模型 / 旗位 / 中文名都注册了，不是空框兜底', () => {
    expect(iconOf('guild')).toContain('<svg');
    expect(iconOf('guild')).not.toContain('stroke-dasharray');
    expect(ARENA_MODELS.guild).toBeTypeOf('function');
    expect(ARENA_FLAGS.guild.pole).toBeGreaterThan(0);
    expect(labelOf({ kind: 'guild' } as unknown as ArenaBuilding)).toBe('商行');
    expect(ruinStyleOf('guild')).toBe('wood');
  });

  it('磨坊卡面：1 人口 / 3 面包 / 1 金币；商行：2 人口 / 1 民居 / 2 金币', () => {
    const mill = supplyRowsHtml(cardById('mill'));
    expect(countIcon(mill, POP_ICON)).toBe(BUILDING_POP.mill);
    expect(countIcon(mill, BREAD_ICON)).toBe(SUPPLY.millBread);
    expect(countIcon(mill, COIN_ICON)).toBe(GOLD_INCOME.mill);
    expect(mill).toContain('data-need="gold"');

    const guild = supplyRowsHtml(cardById('guild'));
    expect(countIcon(guild, POP_ICON)).toBe(BUILDING_POP.guild);
    expect(countIcon(guild, COIN_ICON)).toBe(GOLD_INCOME.guild);
    expect(countIcon(guild, iconOf('house'))).toBe(LOGISTICS.guildHouse);
    expect(countIcon(guild, BREAD_ICON)).toBe(0);
    expect(guild).toContain('data-need="gold"');
    expect(guild).toContain('data-need="house"');
    expect(supplyRows(cardById('guild')).plus).toContain(COIN_ICON);
  });

  it('反证：把 GOLD_INCOME.guild 临时改成 3，卡面立刻画 3 枚金币', () => {
    const before = GOLD_INCOME.guild;
    try {
      GOLD_INCOME.guild = 3;
      expect(countIcon(supplyRowsHtml(cardById('guild')), COIN_ICON)).toBe(3);
    } finally {
      GOLD_INCOME.guild = before;
    }
    expect(countIcon(supplyRowsHtml(cardById('guild')), COIN_ICON)).toBe(2);
  });
});

describe('③ 端到端：真实时间推进下的产金与停摆', () => {
  it('磨坊：没配民居照产 +1 金（自然涨金之外刚好 1）', () => {
    const natural = gainOver(scene());
    const w = scene();
    built(w, 'mill', 2, 2);
    expect(gainOver(w) - natural).toBe(GOLD_INCOME.mill);
  });

  it('商行缺民居：一分不产、isStaffed=false、后勤缺口里报 house', () => {
    const natural = gainOver(scene());
    const w = scene();
    const g = built(w, 'guild', 2, 2);
    expect(w.isStaffed(g.id)).toBe(false);
    expect(w.needStaffing('blue')).toBe(1);
    expect(w['missingLogisticsAll']('blue')).toContain('house');
    expect(gainOver(w)).toBe(natural); // 和空场一模一样 ⇒ 商行确实停摆
  });

  it('补上一座民居：商行开工，每轮多出 GOLD_INCOME.guild 金', () => {
    const natural = gainOver(scene());
    const w = scene();
    const g = built(w, 'guild', 2, 2);
    built(w, 'house', 6, 2);
    expect(w.isStaffed(g.id)).toBe(true);
    expect(w.staffedCount('blue')).toBe(1);
    expect(w['missingLogisticsAll']('blue')).not.toContain('house');
    expect(gainOver(w) - natural).toBe(GOLD_INCOME.guild);
  });

  it('反证：把 GOLD_INCOME.guild 临时改成 5，世界的实收也跟着 +3', () => {
    const normal = (() => {
      const w = scene();
      built(w, 'guild', 2, 2);
      built(w, 'house', 6, 2);
      return gainOver(w);
    })();
    const boosted = (() => {
      const w = scene();
      built(w, 'guild', 2, 2);
      built(w, 'house', 6, 2);
      const before = GOLD_INCOME.guild;
      try {
        GOLD_INCOME.guild = 5;
        return gainOver(w);
      } finally {
        GOLD_INCOME.guild = before;
      }
    })();
    expect(boosted - normal).toBe(3);
  });
});

describe('④ 装配点：AI / HUD / 提示都认得商行', () => {
  const aiView = (houses: number, guilds = 0): AiView => ({
    hand: [cardById('guild')],
    gold: 20,
    count: (k) => (k === 'house' ? houses : k === 'guild' ? guilds : 0),
  });

  it('商行缩在经济后段；没民居时 AI 判 unwise，有民居才 ok，且不许堆第二座', () => {
    expect(placementBand(cardById('guild')).hi).toBeLessThanOrEqual(0.4);
    expect(assess(cardById('guild'), aiView(0))).toBe('unwise');
    expect(assess(cardById('guild'), aiView(2))).toBe('ok');
    expect(assess(cardById('guild'), aiView(3, 1))).toBe('unwise');
  });

  it('愿望清单把商行算进民居需求；HUD 缺配提示不串成「箭塔」', () => {
    expect(wishList((k) => (k === 'guild' ? 1 : 0))[0]).toBe('house');
    expect(read('src/arena/ArenaHud.ts')).toContain('您的商行缺少民居');
    expect(read('src/arena/visuals/ruinView.ts')).toContain("kind === 'guild'");
  });
});
