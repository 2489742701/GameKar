/**
 * 建筑数据表 —— 数值全部在这里，系统层只读表不写死。
 *
 * 平衡思路：金币买建筑、人口卡住同时开工的数量、晶钻只能靠抽卡花，
 * 于是"抽卡 → 盖楼 → 产晶钻 → 再抽卡"自己转起来。
 */

import type { FlatSize } from '@engine/math/Grid';
import type { ResourceId } from '@game/config';

/** 派小人去附近晶脉采矿的配置；缺省表示这栋楼不采矿。 */
export interface VeinWorkSpec {
  resource: ResourceId;
  /** 一个来回背回来的量 */
  perTrip: number;
  /** 小人脚程，格/秒。同样距离下走得快的就是高产 */
  speed: number;
  /** 同时包工的矿点数上限 */
  capacity: number;
}

/** 兵营的一队编制：固定这几种兵、各这么几个。 */
export interface SquadMember {
  unitId: string;
  /** 同时在场几个 */
  size: number;
}

/** 一种弹丸对应一种视图：箭是 2D 精灵，炮弹是 3D 黑方块，魔弹是光点。 */
export type AmmoKind = 'arrow' | 'cannon' | 'magic';

/** 防御塔的射击规格。缺省 = 这栋楼不会打。 */
export interface TowerSpec {
  damage: number;
  /** 射程（格） */
  rangeTiles: number;
  /** 两发之间的间隔（秒） */
  shotSeconds: number;
  /** 弹夹：打空了要装填 */
  magazine: number;
  /** 空仓装填（秒） */
  reloadSeconds: number;
  ammo: AmmoKind;
  /** 溅射半径（格），只有炮塔用 */
  splashTiles?: number;
  /** 升级价目：下标 0 = 升到 Lv2。魔法塔每一级都贵过另两塔同级 */
  upgrades: { gold: number; crystal: number }[];
}

export interface BuildingDef {
  id: string;
  name: string;
  /** 一句人话说明，直接进 UI 卡片 */
  blurb: string;
  model: string;
  footprint: FlatSize;
  cost: Partial<Record<ResourceId, number>>;
  /** 从地基到能用的秒数；0 表示瞬间完成 */
  buildSeconds: number;
  /** 占用人口 */
  population: number;
  /** 提供人口上限 */
  populationCap?: number;
  /** 每秒固定产出（仅建成之后计入，与采矿无关） */
  yields?: Partial<Record<ResourceId, number>>;
  /** 采矿：产量由"附近有没有晶脉、多远"决定 */
  veinWork?: VeinWorkSpec;
  /** 产兵：一栋营只产一支固定小队（数值本体在 data/units.ts） */
  squad?: SquadMember[];
  /**
   * 每回合给面包。面包是容积不是流水：只在回合结算那一刻入账，
   * 所以这里给的是"一回合几个"，不是"每秒几个"。
   */
  breadPerRound?: { base: number; perAdjacentField: number };
  /** 必须贴着这种楼才让盖（田地的"只能放在磨坊旁边"就走这一条） */
  requiresAdjacent?: string;
  /** 防御塔：会自己找敌人开火，缺人手就不开火 */
  tower?: TowerSpec;
  /** 能被敌人拆到几点血；议事厅归零判负 */
  hp: number;
  /** 全场唯一（议事厅） */
  unique?: boolean;
}

export const BUILDINGS: Record<string, BuildingDef> = {
  hall: {
    id: 'hall',
    name: '议事厅',
    blurb: '领地的芯。只有它能稳定渗出晶钻，抽卡的源头。',
    model: 'hall',
    footprint: { cols: 2, rows: 2 },
    cost: {},
    buildSeconds: 6,
    population: 0,
    populationCap: 4,
    yields: { crystal: 0.6, gold: 0.5 },
    unique: true,
    hp: 600,
  },

  house: {
    id: 'house',
    name: '民居',
    blurb: '一栋住 4 个人口，但要吃掉 1 个面包。没面包就盖不起来 —— 去磨坊那边想办法。',
    model: 'house',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 45, bread: 1 },
    buildSeconds: 4,
    population: 0,
    populationCap: 4,
    hp: 200,
  },

  mill: {
    id: 'mill',
    name: '磨坊',
    blurb: '每回合给面包，四周每贴一块田地再多给 1 个。它同时也是面包的仓。',
    model: 'mill',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 130 },
    buildSeconds: 8,
    population: 2,
    breadPerRound: { base: 1, perAdjacentField: 1 },
    hp: 200,
  },

  field: {
    id: 'field',
    name: '田地',
    blurb: '自己不产面包，专门贴在磨坊旁边给那座磨坊加产。离开磨坊就没法开工。',
    model: 'field',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 40 },
    buildSeconds: 5,
    population: 1,
    requiresAdjacent: 'mill',
    hp: 200,
  },

  farm: {
    id: 'farm',
    name: '田庄',
    blurb: '金币主食。两块田就够继续抽下一次十连。',
    model: 'farm',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 70 },
    buildSeconds: 6,
    population: 1,
    yields: { gold: 1.3 },
    hp: 200,
  },

  tower: {
    id: 'tower',
    name: '瞭望塔',
    blurb: '不要人口，占地小。用来把视野探到晶脉那边。',
    model: 'tower',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 90 },
    buildSeconds: 5,
    population: 1,
    hp: 200,
  },

  arrowTower: {
    id: 'arrowTower',
    name: '箭塔',
    blurb: '一弹夹 4 支箭，打完要装 2.5 秒。射程最远的一档，单发不重。',
    model: 'arrowTower',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 120 },
    buildSeconds: 8,
    population: 1,
    tower: {
      damage: 8,
      rangeTiles: 5.5,
      shotSeconds: 0.7,
      magazine: 6,
      reloadSeconds: 2.2,
      ammo: 'arrow',
      upgrades: [{ gold: 120, crystal: 0 }, { gold: 260, crystal: 20 }],
    },
    hp: 320,
  },

  cannonTower: {
    id: 'cannonTower',
    name: '炮塔',
    blurb: '黑色铁弹砸下去炸开一片，1.4 格内都挨。弹夹只有 2 发，装填 5 秒，别指望它连射。',
    model: 'cannonTower',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 200 },
    buildSeconds: 11,
    population: 2,
    tower: {
      damage: 22,
      rangeTiles: 4.5,
      shotSeconds: 1.6,
      magazine: 2,
      reloadSeconds: 5,
      ammo: 'cannon',
      splashTiles: 1.4,
      upgrades: [{ gold: 200, crystal: 20 }, { gold: 420, crystal: 60 }],
    },
    hp: 360,
  },

  magicTower: {
    id: 'magicTower',
    name: '魔法塔',
    blurb: '快得看不清的一串光弹，单发很轻，胜在不停手。升级最贵的一座。',
    model: 'magicTower',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 180, crystal: 40 },
    buildSeconds: 12,
    population: 2,
    tower: {
      damage: 3,
      rangeTiles: 6,
      shotSeconds: 0.22,
      magazine: 10,
      reloadSeconds: 3,
      ammo: 'magic',
      upgrades: [{ gold: 300, crystal: 60 }, { gold: 560, crystal: 140 }],
    },
    hp: 320,
  },

  mine: {
    id: 'mine',
    name: '矿井',
    blurb: '派小人去附近的晶脉采矿。矿越远，路上耗得越多，产量越低；附近没矿就一分钱不产。',
    model: 'mine',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 110 },
    buildSeconds: 9,
    population: 2,
    veinWork: { resource: 'crystal', perTrip: 2, speed: 1.2, capacity: 2 },
    hp: 200,
  },

  market: {
    id: 'market',
    name: '市集',
    blurb: '金币产出最高的民用建筑，代价是要三个人。',
    model: 'market',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 150 },
    buildSeconds: 10,
    population: 2,
    yields: { gold: 2.4 },
    hp: 200,
  },

  barracks: {
    id: 'barracks',
    name: '兵营',
    blurb: '驻一支骑士小队。兵出营后在营外一圈自动布防，敌人进圈就打。',
    model: 'barracks',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 200 },
    buildSeconds: 14,
    population: 4,
    squad: [{ unitId: 'knight', size: 3 }],
    hp: 260,
  },

  archery: {
    id: 'archery',
    name: '弓手营',
    blurb: '四个弓箭手。射程 3.6 格，血薄，别让他们站在兽人前面。',
    model: 'archery',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 160 },
    buildSeconds: 10,
    population: 4,
    squad: [{ unitId: 'archer', size: 4 }],
    hp: 260,
  },

  warren: {
    id: 'warren',
    name: '兽穴',
    blurb: '三个兽人，每 6 秒冲撞一次，把撞到的敌人顶开并定身。用来撕开敌群。',
    model: 'warren',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 240 },
    buildSeconds: 15,
    population: 4,
    squad: [{ unitId: 'orc', size: 3 }],
    hp: 260,
  },

  temple: {
    id: 'temple',
    name: '神龛',
    blurb: '两个牧师，不打人，只奶附近血最少的那个。死了这条线就断了。',
    model: 'temple',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 260 },
    buildSeconds: 16,
    population: 4,
    squad: [{ unitId: 'priest', size: 2 }],
    hp: 260,
  },

  refinery: {
    id: 'refinery',
    name: '精炼厂',
    blurb: '同样靠附近的晶脉吃饭，但小人脚程快、能同时包三个矿点，所以高产。',
    model: 'refinery',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 180 },
    buildSeconds: 12,
    population: 3,
    veinWork: { resource: 'crystal', perTrip: 2.2, speed: 3.2, capacity: 3 },
    hp: 200,
  },
};

export const buildingList = (): BuildingDef[] => Object.values(BUILDINGS);

export function buildingDef(id: string): BuildingDef {
  const def = BUILDINGS[id];
  if (!def) throw new Error(`未知建筑 "${id}"`);
  return def;
}

/** 给 UI 用的宽容版：数据表里查不到就退回 id，绝不为一个名字抛异常。 */
export function buildingName(id: string): string {
  return BUILDINGS[id]?.name ?? id;
}

/**
 * 这栋楼配不配有一面集合旗 —— 判据只写在这一处：
 * UI 决定画不画旗、以后的兵营系统决定听不听这个格子，两边都读它，不会各判各的。
 */
export const hasRally = (def: BuildingDef): boolean => (def.squad?.length ?? 0) > 0;
