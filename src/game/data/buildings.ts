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
    blurb: '派小人去附近的晶脉采矿。矿越远，路上耗得越多，产量越低；附近没矿就一分钱不产。',
    model: 'mine',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 110 },
    buildSeconds: 9,
    population: 2,
    veinWork: { resource: 'crystal', perTrip: 2, speed: 1.2, capacity: 2 },
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
    blurb: '同样靠附近的晶脉吃饭，但小人脚程快、能同时包三个矿点，所以高产。',
    model: 'refinery',
    footprint: { cols: 2, rows: 2 },
    cost: { gold: 180 },
    buildSeconds: 12,
    population: 3,
    veinWork: { resource: 'crystal', perTrip: 2.2, speed: 3.2, capacity: 3 },
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
