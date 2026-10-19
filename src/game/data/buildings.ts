/**
 * 建筑数据表 —— 数值全部在这里，系统层只读表不写死。
 *
 * 平衡思路：金币买建筑、人口卡住同时开工的数量、晶钻只能靠抽卡花，
 * 于是"抽卡 → 盖楼 → 产晶钻 → 再抽卡"自己转起来。
 */

import type { FlatSize } from '@engine/math/Grid';
import type { ResourceId, TerrainType } from '@game/config';

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
  /** 每秒产出（仅建成之后计入） */
  yields?: Partial<Record<ResourceId, number>>;
  /** 只允许盖在某种地形上 */
  requiresTerrain?: TerrainType;
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
  },

  house: {
    id: 'house',
    name: '民居',
    blurb: '最便宜的人口上限。人口不够，什么都盖不了。',
    model: 'house',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 45 },
    buildSeconds: 4,
    population: 0,
    populationCap: 3,
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
  },

  tower: {
    id: 'tower',
    name: '瞭望塔',
    blurb: '不要人口，占地小。用来把视野探到晶脉那边。',
    model: 'tower',
    footprint: { cols: 1, rows: 1 },
    cost: { gold: 90 },
    buildSeconds: 5,
    population: 0,
  },

  mine: {
    id: 'mine',
    name: '矿井',
    blurb: '晶钻的主要来源，随便盖在哪都出矿，但盖在晶脉上翻倍。',
    model: 'mine',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 110 },
    buildSeconds: 9,
    population: 2,
    yields: { crystal: 0.5 },
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
  },

  barracks: {
    id: 'barracks',
    name: '兵营',
    blurb: '现在还不生产兵。先把位置占住，等人物模型和战斗上线。',
    model: 'barracks',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 200 },
    buildSeconds: 14,
    population: 3,
  },

  refinery: {
    id: 'refinery',
    name: '精炼厂',
    blurb: '必须压在晶脉上，晶钻产出是矿井的三倍。抽到图纸就赶紧找矿。',
    model: 'refinery',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 180 },
    buildSeconds: 12,
    population: 3,
    yields: { crystal: 1.6 },
    requiresTerrain: 'vein',
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

/** 建在晶脉上的额外加成，写在系统层之外的这里，方便调。 */
export const TERRAIN_BONUS: Partial<Record<TerrainType, number>> = { vein: 2 };
