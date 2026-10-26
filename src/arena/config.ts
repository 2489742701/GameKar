/**
 * 对战模式的全部可调数值 —— 集中在这一处，逻辑层一行不写死。
 *
 * 设计口径（用户 2026-10-27 定的方向 + 我拍的数，见 docs/工作笔记/对战模式计划流水账）：
 * **以建筑为主、军队为辅**：建筑贵、军队便宜，但建筑能一直产出（兵营出兵、磨坊生金、塔防守），
 * 所以"先立建筑"是自然选择，而不是靠规则强按。
 *
 * 和《皇室战争》刻意不同的一条：**建筑没有寿命**。不会自己掉血、更不会定时消失，
 * 只能被兵拆掉。这一条是用户点名要的，别顺手加回来。
 */

import type { UnitDef } from '@game/data/units';

export type Side = 'blue' | 'red';

/** 战场：竖屏为主，蓝在南（下方），红在北（上方）。 */
export const FIELD = {
  cols: 16,
  rows: 26,
  /** 中间这条线两侧各归一方，兵只能放在自己这半场 */
  midRow: 13,
};

export const ECONOMY = {
  /** 金币上限：用户点名 20 点 */
  cap: 20,
  /** 开局各 5 点，先够打一张便宜的 */
  start: 5,
  /** 每秒回多少：满 20 约 12.5 秒，够打一张 8 费 */
  perSecond: 1.2,
  /** 磨坊每隔多久吐一次金，每次多少 */
  millInterval: 5,
  millBonus: 2,
};

export const CORE = {
  /** 双方主城（核心）的格子尺寸与血量 */
  cols: 2,
  rows: 2,
  hp: 1200,
};

export const BARRACKS = {
  /** 兵营每隔几秒自动出一个兵（不花金） */
  interval: 6,
  /** 一栋兵营最多同时在场几个兵，超了就不再出 */
  cap: 6,
  hp: 420,
};

export const TOWER = {
  /** 箭塔 */
  arrow: { hp: 520, damage: 9, range: 5.5, interval: 0.75, ammo: 'arrow' as const },
  /** 炮塔：慢、重、带溅射 */
  cannon: { hp: 640, damage: 24, range: 4.4, interval: 1.7, ammo: 'cannon' as const, splash: 1.3 },
};

export const MILL = { hp: 300 };

/** 手牌：4 张，打出去之后进冷却再补一张新的。 */
export const HAND = { size: 4, refillSeconds: 2.2 };

/** 兵的基础口径（秒/格沿用战斗内核那一套）。 */
export const UNIT = {
  /** 索敌半径：兵看见这个范围内的敌人就贴上去打 */
  sight: 4.2,
  /** 攻击间隔（各自的 cooldown 会在单位表里再乘一次） */
  moveStep: 0.02,
};

export type CardKind = 'building' | 'squad';

export interface ArenaCard {
  id: string;
  name: string;
  blurb: string;
  kind: CardKind;
  /** 花多少金 */
  cost: number;
  /** 建筑卡：模型与规格 */
  building?: 'barracks' | 'arrowTower' | 'cannonTower' | 'mill';
  /** 军队卡：出哪几种、各几个 */
  squad?: { unitId: string; count: number }[];
}

/**
 * 卡池。随机发 4 张进手牌（配卡组以后再做）。
 * 建筑贵、军队便宜 —— 这条差价就是"先立建筑"的钩子。
 */
export const CARDS: ArenaCard[] = [
  {
    id: 'barracks',
    name: '兵营',
    blurb: '每 6 秒自动出一个守兵，不花金。站稳脚跟的第一步。',
    kind: 'building',
    cost: 6,
    building: 'barracks',
  },
  {
    id: 'arrowTower',
    name: '箭塔',
    blurb: '自动打靠近的敌人，射程 5.5 格。便宜的防守。',
    kind: 'building',
    cost: 5,
    building: 'arrowTower',
  },
  {
    id: 'cannonTower',
    name: '炮塔',
    blurb: '一发 24 伤、炸一片，但很慢。放在兵营前面当闸门。',
    kind: 'building',
    cost: 7,
    building: 'cannonTower',
  },
  {
    id: 'mill',
    name: '磨坊',
    blurb: '每 5 秒多给 2 金。前期投资，回本要一会儿。',
    kind: 'building',
    cost: 4,
    building: 'mill',
  },
  {
    id: 'archers',
    name: '弓箭手小队',
    blurb: '一次三个弓箭手。便宜、脆、射得远。',
    kind: 'squad',
    cost: 3,
    squad: [{ unitId: 'archer', count: 3 }],
  },
  {
    id: 'orcs',
    name: '兽人',
    blurb: '两个兽人，血厚、冲撞会把对面顶开。',
    kind: 'squad',
    cost: 4,
    squad: [{ unitId: 'orc', count: 2 }],
  },
];

export const cardById = (id: string): ArenaCard => {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`未知卡牌 "${id}"`);
  return c;
};

/** 建筑卡 → 占地/血量/行为。表在这里，逻辑层只读。 */
export const BUILDING_SPECS = {
  barracks: { cols: 2, rows: 2, hp: BARRACKS.hp },
  arrowTower: { cols: 1, rows: 1, hp: TOWER.arrow.hp },
  cannonTower: { cols: 1, rows: 1, hp: TOWER.cannon.hp },
  mill: { cols: 1, rows: 1, hp: MILL.hp },
} as const;

export type BuildingKind = keyof typeof BUILDING_SPECS;

/** 敌方 AI 的节奏：多久想一次、出手的随机上限。 */
export const AI = {
  thinkSeconds: 2.5,
  /** 它优先攒钱立建筑；建筑到几栋之后才开始出小队 */
  buildingsBeforeSquad: 2,
};

/** 阵营色带：己方蓝、敌方红（像素小人的 suit 槽）。 */
export const FACTION_TINT = {
  blue: { suitBands: 'blue', label: '蓝方' },
  red: { suitBands: 'red', label: '红方' },
} as const;

/** 单位表的形状校验用：卡池里提到的兵种必须真的存在。 */
export type ArenaUnitRef = Pick<UnitDef, 'id' | 'name' | 'hp' | 'attack' | 'defense' | 'range' | 'speed'>;
