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
  /**
   * 横版：34 列宽、20 行高。左边（小 col）是蓝方，右边是红方。
   * 建筑统一 3×3 之后，26×16 太挤（一栋楼就占掉半个半场），所以整体放大一档。
   */
  cols: 42,
  rows: 20,
  /** 中间这条线左右各归一方，兵只能放在自己这半场 */
  midCol: 21,
};

/**
 * 中间的**禁建带**（用户 2026-10-27 第二次要求加长：从 3 列加到 5 列）。
 * 以 midCol 为中心左右各 2 格 ⇒ 5 列宽的"无人区"：楼和兵都放不进去，
 * 两边的射程够不着对面，谁先越过谁挨打。地块本身染成黄沙色（见 ArenaApp）。
 */
export const NO_BUILD = { halfWidth: 2, color: 0xd8b45c };

export const ECONOMY = {
  /** 金币上限：用户点名 20 点 */
  cap: 20,
  /** 开局各 8 点：够先立一栋建筑再补一张小队 */
  start: 8,
  /**
   * 金币按**跳格**涨：每 1.5 秒 +1（用户 2026-10-27："金钱每 1.5 秒钟才涨一个"）。
   * 不是连续小数——数字要一格一格跳，玩家才数得清。
   */
  tickSeconds: 1.5,
  perTick: 1,
  /** 磨坊每隔多久吐一次金，每次多少 */
  millInterval: 5,
  millBonus: 2,
};

/**
 * 对战模式的机位 —— 和老模式（45° 斜看）不一样，这里**正对**战场：
 * 蓝在下、红在上，和皇室战争那种"上下对峙"的读图一致。
 * 斜 45° 会把场地转成菱形，四角全是黑洞（截图里就是这个毛病）。
 */
export const ARENA_CAMERA = {
  pitchDeg: 52,
  yawDeg: 0,
  /** 16 列宽的场地整幅入画，两侧留一点边 */
  tilesAcross: 30,
  minTilesAcross: 12,
  maxTilesAcross: 44,
};

export const CORE = {
  /** 双方主城（核心）：3×3 占地（用户定的"建筑物默认占 3×3"） */
  cols: 3,
  rows: 3,
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
  arrow: { hp: 520, damage: 9, range: 6.8, interval: 0.75, ammo: 'arrow' as const },
  /** 炮塔：慢、重、带溅射 */
  cannon: { hp: 640, damage: 24, range: 5.6, interval: 1.7, ammo: 'cannon' as const, splash: 1.3 },
};

export const MILL = { hp: 300 };

/**
 * 民居：不出兵也不产金，专门给兵营当"后勤"（用户 2026-10-27：
 * "一个军营配一个磨坊一个民居，否则无法生产"）。
 */
export const HOUSE = { hp: 220 };

/** 手牌：4 张，打出去之后进冷却再补一张新的。 */
export const HAND = { size: 4, refillSeconds: 2.2 };

/**
 * 对战模式里小人的显示身高（格）。
 * 比老模式（1.12）高一档：这一版兵少、镜头拉得更近，1.45 才看得清脸和动作。
 * 注意这是**等比放大**（宽度跟着高），不是把贴图拉扁。
 */
export const UNIT_HEIGHT = 1.45;

/** 兵的基础口径（秒/格沿用战斗内核那一套）。 */
export const UNIT = {
  /** 索敌半径：兵看见这个范围内的敌人就贴上去打 */
  sight: 4.2,
  /** 攻击间隔（各自的 cooldown 会在单位表里再乘一次） */
  moveStep: 0.02,
};

export type CardKind = 'building' | 'squad' | 'siege';

export interface ArenaCard {
  id: string;
  name: string;
  blurb: string;
  kind: CardKind;
  /** 花多少金 */
  cost: number;
  /** 建筑卡：模型与规格 */
  building?: 'barracks' | 'arrowTower' | 'cannonTower' | 'mill' | 'house';
  /** 军队卡：出哪几种、各几个 */
  squad?: { unitId: string; count: number }[];
}

/**
 * 卡池。随机发 4 张进手牌（配卡组以后再做）。
 * 建筑贵、军队便宜 —— 这条差价就是"先立建筑"的钩子。
 * 2026-10-27 用户要求「所有的东西的价格再贵一倍」，下面六个数全部 ×2（写在字面量里，不做运行时乘）。
 */
export const CARDS: ArenaCard[] = [
  {
    id: 'barracks',
    name: '兵营',
    blurb: '每 6 秒自动出一个守兵，不花金。站稳脚跟的第一步。',
    kind: 'building',
    cost: 12,
    building: 'barracks',
  },
  {
    id: 'arrowTower',
    name: '箭塔',
    blurb: '自动打靠近的敌人，射程 6.8 格。便宜的防守。',
    kind: 'building',
    cost: 10,
    building: 'arrowTower',
  },
  {
    id: 'cannonTower',
    name: '炮塔',
    blurb: '一发 24 伤、炸一片，但很慢。放在兵营前面当闸门。',
    kind: 'building',
    cost: 14,
    building: 'cannonTower',
  },
  {
    id: 'mill',
    name: '磨坊',
    blurb: '每 5 秒多给 2 金。前期投资，回本要一会儿。',
    kind: 'building',
    cost: 8,
    building: 'mill',
  },
  {
    id: 'archers',
    name: '弓箭手小队',
    blurb: '一次三个弓箭手。便宜、脆、射得远。',
    kind: 'squad',
    cost: 6,
    squad: [{ unitId: 'archer', count: 3 }],
  },
  {
    id: 'mobileCannon',
    name: '移动火炮',
    blurb: '两个小人推着走，射程比塔还远。拆塔也打兵，慢、脆、贵，但它能白嫖塔。',
    kind: 'siege',
    cost: 16,
    squad: [{ unitId: 'mobileCannon', count: 1 }],
  },
  {
    id: 'ballista',
    name: '移动弩箭',
    blurb: '一台大弩车，专点步兵：射程 6 格、一发重伤，但拆不了楼。',
    kind: 'siege',
    cost: 12,
    squad: [{ unitId: 'ballista', count: 1 }],
  },
  {
    id: 'house',
    name: '民居',
    blurb: '兵营的后勤：每座兵营要配 1 座磨坊 + 1 座民居才会出兵。',
    kind: 'building',
    cost: 6,
    building: 'house',
  },
  {
    id: 'knights',
    name: '骑士小队',
    blurb: '两个骑士：血厚、防高，顶在最前面。',
    kind: 'squad',
    cost: 9,
    squad: [{ unitId: 'knight', count: 2 }],
  },
  {
    id: 'mages',
    name: '法师小队',
    blurb: '两个法师，3.3 格外放法术弹，打兵打楼都疼。',
    kind: 'squad',
    cost: 11,
    squad: [{ unitId: 'mage', count: 2 }],
  },
  {
    id: 'priests',
    name: '牧师小队',
    blurb: '两个牧师：每 2.5 秒给身边 3 格内的自己人回 6 血，攻弱。',
    kind: 'squad',
    cost: 10,
    squad: [{ unitId: 'priest', count: 2 }],
  },
  {
    id: 'golem',
    name: '石怪',
    blurb: '一只石怪：走得慢，但血厚防高，扛线最合适。',
    kind: 'squad',
    cost: 9,
    squad: [{ unitId: 'golem', count: 1 }],
  },
  {
    id: 'mech',
    name: '机器巨人',
    blurb: '一台机器巨人：慢、笨重，但一拳能砸穿墙。',
    kind: 'squad',
    cost: 16,
    squad: [{ unitId: 'mech', count: 1 }],
  },
  {
    id: 'orcs',
    name: '兽人',
    blurb: '两个兽人，血厚、冲撞会把对面顶开。',
    kind: 'squad',
    cost: 8,
    squad: [{ unitId: 'orc', count: 2 }],
  },
];

export const cardById = (id: string): ArenaCard => {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`未知卡牌 "${id}"`);
  return c;
};

/** 建筑卡 → 占地/血量/行为。表在这里，逻辑层只读。 */
/**
 * 占地：**所有建筑一律 3×3**（用户 2026-10-27 定的）。
 * 视觉上模型只有 1 格大，所以视图层会按 3 格再放大一次（见 ArenaApp 的 BUILDING_SCALE）。
 */
export const BUILDING_SPECS = {
  barracks: { cols: 3, rows: 3, hp: BARRACKS.hp },
  arrowTower: { cols: 3, rows: 3, hp: TOWER.arrow.hp },
  cannonTower: { cols: 3, rows: 3, hp: TOWER.cannon.hp },
  mill: { cols: 3, rows: 3, hp: MILL.hp },
  house: { cols: 3, rows: 3, hp: HOUSE.hp },
} as const;

/** 模型放大倍率：占到 3×3 之后，不放大就只是格子里的一小块。 */
export const BUILDING_SCALE = 2.2;

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

/**
 * 移动火炮（用户 2026-10-27 点名要的"工程设备"）：
 * 两个小人在后面推，车上架一门 3D 火炮，**射程比防御塔还远** —— 就是拿来白嫖塔的。
 * 代价写在这一行里：贵（16 金）、慢（0.5 格/秒）、脆（90 血）、装填很久（2.8 秒）。
 * 2026-10-27 用户修正：**它也要打兵**（之前只拆建筑，兵走到脸上它都不理）。
 */
export const MOBILE = {
  hp: 90,
  speed: 0.5,
  range: 7.2,
  damage: 26,
  cooldown: 2.8,
  /** 索敌半径（兵和楼都看） */
  sight: 8,
  /** 两个推车的人：位置相对车尾，纯视觉 */
  pushers: 2,
};

/**
 * 移动弩箭（用户 2026-10-27）：和移动火炮**反过来**的攻城/反步兵单位 ——
 * 射程 6 格、一发 26 伤，专门点步兵；但它**只打兵不拆楼**。
 */
export const BALLISTA = {
  hp: 70,
  speed: 0.55,
  range: 6,
  damage: 26,
  cooldown: 2.2,
  sight: 6.5,
  pushers: 1,
};

/** 废墟：被拆掉的建筑在原地留一堆碎石，过这么久自己塌平。 */
export const RUIN = {
  seconds: 14,
  /** 最后几秒开始淡出 */
  fadeSeconds: 2.5,
};
