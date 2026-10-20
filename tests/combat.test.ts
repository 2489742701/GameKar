/**
 * 战斗数据的锁（系统层还没上，先把"表能不能自洽"钉住）。
 *
 * 计划板 P-002 §4 的锁 1)（伤害下限）与"小队编制"那两条都在这里；
 * 索敌/回血/冲撞的锁等 `systems/Combat.ts` 落地再加进本文件。
 */

import { describe, expect, it } from 'vitest';
import { BUILDINGS, buildingDef, buildingList } from '@game/data/buildings';
import { UNITS, damageOf, unitDef, unitList } from '@game/data/units';
import { STARTER_POOL, CARDS } from '@game/data/cards';

const squadBuildings = () => buildingList().filter((b) => b.squad);

describe('伤害公式', () => {
  it('攻 12 防 5 打 7；攻 3 防 5 打下限 1（堆防不会堆成不死）', () => {
    expect(damageOf(12, 5)).toBe(7);
    expect(damageOf(3, 5)).toBe(1);
    expect(damageOf(5, 5)).toBe(1);
    expect(damageOf(0, 0)).toBe(1);
  });
});

describe('小队编制与单位表互相指得到', () => {
  it('每栋营的 squad 都指向玩家能造的兵种，且数量至少 1', () => {
    expect(squadBuildings().length).toBe(4);
    for (const b of squadBuildings()) {
      for (const m of b.squad!) {
        const u = unitDef(m.unitId);
        expect(u.faction).toBe('own');
        expect(m.size).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('四个自己的兵种各自被一栋营产出 —— 没有"抽不到也造不出的兵"', () => {
    const produced = new Set(squadBuildings().flatMap((b) => b.squad!.map((m) => m.unitId)));
    expect([...produced].sort()).toEqual(['archer', 'knight', 'orc', 'priest']);
    for (const id of produced) expect(UNITS[id]).toBeTruthy();
  });

  it('敌方兵种一律不由玩家产出（波次是唯一的敌人来源）', () => {
    const foes = unitList().filter((u) => u.faction === 'enemy');
    expect(foes.map((u) => u.id).sort()).toEqual(['golem', 'raider', 'shade']);
    for (const foe of foes) expect(foe.trainSeconds).toBe(0);
  });
});

describe('建筑血量（谁挨打得起）', () => {
  // 这条是 P-002 定的"议事厅 400、兵营类 260、其余 200"。
  // P-007 加了三种塔（240/280/240），所以"其余"那一档要先把塔摘出去 —— 不是把 200 改掉。
  const TOWERS = ['arrowTower', 'cannonTower', 'magicTower'];

  // 400/240/280 那组数是 P-002 拍的；实测第 1 波 45 秒就把主城拆光（32 点/秒 vs 总血量 1040），
  // 所以整族往上抬了一档。改的是数值，不是"打不打得动"这件事本身。
  it('议事厅 600、四栋营 260、三座塔 320/360/320、其余 200', () => {
    expect(BUILDINGS.hall!.hp).toBe(600);
    for (const b of squadBuildings()) expect(b.hp).toBe(260);
    expect(BUILDINGS.arrowTower!.hp).toBe(320);
    expect(BUILDINGS.cannonTower!.hp).toBe(360);
    expect(BUILDINGS.magicTower!.hp).toBe(320);
    for (const b of buildingList().filter((x) => !x.squad && !TOWERS.includes(x.id) && x.id !== 'hall')) {
      expect(b.hp).toBe(200);
    }
  });

  it('每栋楼都写了血量，不给"缺省=打不死"留口子', () => {
    for (const b of buildingList()) expect(b.hp).toBeGreaterThan(0);
  });
});

describe('卡池里加了军事卡之后', () => {
  it('每张新营卡都进了池子，稀有度也填对', () => {
    const byRarity = (r: string) =>
      STARTER_POOL.entries.filter((e) => CARDS[e.cardId]!.rarity === r).map((e) => e.cardId);
    expect(byRarity('rare')).toContain('bowyerWarrant');
    expect(byRarity('epic')).toEqual(expect.arrayContaining(['warrenTreaty', 'templeDecree', 'recruitDecree']));
  });

  it('精英带权重合计 148 —— 两张塔卡把精炼厂从 30/100 稀释到 30/148，这条是故意的，改它要留字据', () => {
    const epic = STARTER_POOL.entries
      .filter((e) => CARDS[e.cardId]!.rarity === 'epic')
      .reduce((sum, e) => sum + e.weight, 0);
    expect(epic).toBe(148);
    expect(30 / epic).toBeLessThan(0.21);
  });
});

describe('三座塔的射击规格', () => {
  const towers = () => buildingList().filter((b) => b.tower);

  it('三塔齐备，弹丸种类各不相同（视图按这个分派 2D 箭 / 3D 铁弹 / 光弹）', () => {
    expect(towers().map((b) => b.id).sort()).toEqual(['arrowTower', 'cannonTower', 'magicTower']);
    expect(new Set(towers().map((b) => b.tower!.ammo)).size).toBe(3);
  });

  it('魔法塔最快最弱、炮塔最慢最重且带溅射、箭塔射程最远 —— 三档差异是真的', () => {
    const spec = (id: string) => buildingDef(id).tower!;
    expect(spec('magicTower').shotSeconds).toBeLessThan(spec('arrowTower').shotSeconds);
    expect(spec('magicTower').damage).toBeLessThan(spec('arrowTower').damage);
    expect(spec('cannonTower').damage).toBeGreaterThan(spec('arrowTower').damage);
    expect(spec('cannonTower').splashTiles).toBeGreaterThan(0);
    expect(spec('arrowTower').rangeTiles).toBeGreaterThan(spec('cannonTower').rangeTiles);
    // 弹夹与装填也各不相同
    expect(new Set(towers().map((b) => b.tower!.magazine)).size).toBe(3);
    expect(new Set(towers().map((b) => b.tower!.reloadSeconds)).size).toBe(3);
  });

  it('升级价：魔法塔每一级都贵过另两塔同级，且升级不靠抽卡（只花金币与水晶）', () => {
    for (let level = 0; level < 2; level++) {
      const magic = buildingDef('magicTower').tower!.upgrades[level]!;
      for (const id of ['arrowTower', 'cannonTower']) {
        const other = buildingDef(id).tower!.upgrades[level]!;
        expect(magic.gold + magic.crystal * 4).toBeGreaterThan(other.gold + other.crystal * 4);
      }
    }
    for (const b of towers()) {
      for (const price of b.tower!.upgrades) expect(Object.keys(price).sort()).toEqual(['crystal', 'gold']);
    }
  });

  it('岗位数按用户口径：塔楼 1、炮塔与魔法塔 2、兵营类 4', () => {
    expect(buildingDef('tower').population).toBe(1);
    expect(buildingDef('arrowTower').population).toBe(1);
    expect(buildingDef('cannonTower').population).toBe(2);
    expect(buildingDef('magicTower').population).toBe(2);
    for (const b of squadBuildings()) expect(b.population).toBe(4);
  });
});
