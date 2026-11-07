/**
 * 2026-11-07 中午的经济规则锁（用户："单位调整 SVG 也要一起落地，卡面也要一起落地"）：
 *  磨坊只扣 1 人口 / 加 2 面包；箭塔 1 人口、炮塔 2；
 *  民兵集结不占人口；兽人军队不占人口但吃双倍面包；
 *  新增兽人巢穴（只花钱就能造，造完解锁全部兽人军队）。
 *
 * 三条线分开验：① 判据表本身 ② 落牌后的真实读数 ③ 卡面 SVG 图标个数。
 * 重点是 ③ —— 判据改了但 SVG 还画旧的"扣 2 人口"，玩家看到的就是假读数。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import {
  BUILDING_POP, BUILDING_SPECS, SUPPLY, TECH,
  armySupplyOf, buildingPopOf, cardById,
} from '@arena/config';
import { iconOf } from '@arena/cardIcons';
import { ARENA_MODELS } from '@arena/models';
import { needsStaffing } from '@arena/visuals/labels';
import { supplyRows, supplyRowsHtml } from '@arena/visuals/supplyRows';
import { BREAD_ICON, POP_ICON } from '@arena/supplyIcons';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const countIcon = (html: string, svg: string): number => html.split(svg).length - 1;

/** 造一栋完工楼（跳过施工，锁的是规则不是动画）。 */
function built(w: ArenaWorld, kind: keyof typeof BUILDING_SPECS, col: number, row: number) {
  const b = w['place']('blue', kind, col, row, 500);
  b.build = 1;
  return b;
}

function put(w: ArenaWorld, id: string, col = 6, row = 4) {
  w.hands.blue[0] = cardById(id);
  w.handCooldowns.blue[0] = 0;
  w.gold.blue = 30;
  return w.playCard('blue', 0, col, row);
}

describe('判据表：建筑人口与军队口粮', () => {
  it('磨坊 1 / 箭塔 1 / 炮塔 2 / 民居 0 / 兽人巢穴 2', () => {
    expect(BUILDING_POP.mill).toBe(1);
    expect(BUILDING_POP.arrowTower).toBe(1);
    expect(BUILDING_POP.cannonTower).toBe(2);
    expect(BUILDING_POP.house).toBe(0);
    expect(BUILDING_POP.orcLair).toBe(2);
    expect(buildingPopOf('mill')).toBe(1);
  });

  it('民兵 / 兽人零人口；兽人双倍面包；普通兵各 1', () => {
    expect(armySupplyOf(cardById('militia'))).toEqual({ popPerMan: 0, breadPerMan: 0.5 });
    for (const id of TECH.orcCards) {
      expect(armySupplyOf(cardById(id)), id).toEqual({ popPerMan: 0, breadPerMan: 2 });
    }
    expect(armySupplyOf(cardById('knights'))).toEqual({ popPerMan: SUPPLY.unitPop, breadPerMan: 1 });
  });

  it('兽人巢穴：3×3、只要钱就能盖（不需要后勤配给），模型与卡图标都注册了', () => {
    expect(BUILDING_SPECS.orcLair.cols).toBe(3);
    expect(cardById('orcLair').kind).toBe('building');
    expect(needsStaffing('orcLair')).toBe(false);
    expect(ARENA_MODELS.orcLair).toBeTypeOf('function');
    expect(iconOf('orcLair')).toContain('<svg');
    expect(iconOf('orcLair')).not.toContain('stroke-dasharray'); // 不是空框兜底
  });
});

describe('端到端：落牌后的真实读数', () => {
  it('磨坊 +2 面包上限、只占 1 人口；箭塔 1、炮塔 2', () => {
    const w = new ArenaWorld({ seed: 401 });
    w.auto.red = false;
    built(w, 'mill', 2, 2);
    built(w, 'arrowTower', 6, 2);
    built(w, 'cannonTower', 10, 2);
    const s = w.supplyOf('blue');
    expect(s.pop).toBe(1 + 1 + 2);
    expect(s.breadMax).toBe(SUPPLY.baseBread + SUPPLY.millBread);
  });

  it('民兵：6 人只吃 3 面包、人口读数一点不涨', () => {
    const w = new ArenaWorld({ seed: 402 });
    w.auto.red = false;
    expect(put(w, 'militia').ok).toBe(true);
    const s = w.supplyOf('blue');
    expect(s.pop).toBe(0);
    expect(s.bread).toBe(3);
    expect(w.units.every((u) => u.popCost === 0)).toBe(true);
  });

  it('兽人：建好巢穴才能出；0 人口但 2 人吃 4 面包（需磨坊撑容器）', () => {
    const w = new ArenaWorld({ seed: 403 });
    w.auto.red = false;
    expect(w.techAllows('blue', cardById('orcs'))).toBe(false);
    built(w, 'orcLair', 2, 2);
    built(w, 'mill', 6, 2); // 面包上限 3+2=5，够 4
    expect(w.techAllows('blue', cardById('orcs'))).toBe(true);
    const before = w.supplyOf('blue').pop;
    expect(put(w, 'orcs', 10, 6).ok).toBe(true);
    const s = w.supplyOf('blue');
    expect(s.pop - before, '兽人不占人口').toBe(0);
    expect(s.bread).toBe(4);
    expect(w.units.every((u) => u.breadCost === 2 && u.popCost === 0)).toBe(true);
  });

  it('兽人大队：4 人吃 8 面包，基础容器盖磨坊也装不下 ⇒ 被面包拦住', () => {
    const w = new ArenaWorld({ seed: 404 });
    w.auto.red = false;
    built(w, 'orcLair', 2, 2);
    built(w, 'mill', 6, 2);
    const res = put(w, 'orcsBig', 10, 6);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('面包');
  });
});

describe('卡面 SVG 跟着判据走', () => {
  it('磨坊画出 1 个人口、2 个面包；箭塔 1 人、炮塔 2 人', () => {
    const mill = supplyRowsHtml(cardById('mill'));
    expect(countIcon(mill, POP_ICON)).toBe(1);
    expect(countIcon(mill, BREAD_ICON)).toBe(2);
    expect(countIcon(supplyRowsHtml(cardById('arrowTower')), POP_ICON)).toBe(1);
    expect(countIcon(supplyRowsHtml(cardById('cannonTower')), POP_ICON)).toBe(2);
  });

  it('民兵 / 兽人不画人口图标，面包按实际口粮画', () => {
    const militia = supplyRowsHtml(cardById('militia'));
    expect(countIcon(militia, POP_ICON)).toBe(0);
    expect(countIcon(militia, BREAD_ICON)).toBe(3);

    const orcs = supplyRowsHtml(cardById('orcs'));
    expect(countIcon(orcs, POP_ICON)).toBe(0);
    expect(countIcon(orcs, BREAD_ICON)).toBe(1); // 4 个走「1 个图标 + ×4」缩写
    expect(orcs).toContain('×4');
    expect(supplyRows(cardById('orcsBig')).minus).toContain('×8');
  });

  it('兽人巢穴卡面：占 2 人口，且图标是自己的不是兜底空框', () => {
    expect(countIcon(supplyRowsHtml(cardById('orcLair')), POP_ICON)).toBe(2);
    expect(supplyRows(cardById('orcLair')).plus).toBe('');
  });

  it('装配锁：判据、AI、卡面读同一张表，没有谁自己写一个 2', () => {
    const world = read('src/arena/ArenaWorld.ts');
    const ai = read('src/arena/ai.ts');
    const rows = read('src/arena/visuals/supplyRows.ts');
    expect(world).toContain('buildingPopOf(b.kind)');
    expect(world).toContain('armySupplyOf(card)');
    expect(ai).toContain('buildingPopOf(card.building!)');
    expect(ai).toContain('armySupplyOf(card)');
    expect(rows).toContain('buildingPopOf(');
    expect(rows).toContain('armySupplyOf(card)');
    expect(rows).not.toContain('SUPPLY.buildingPop');
    expect(world).not.toContain('SUPPLY.buildingPop');
  });
});
