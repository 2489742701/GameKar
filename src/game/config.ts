/**
 * 全局调参处 —— 数值、颜色、手感集中在这里，其余模块只读不猜。
 */

import type { FlatSize } from '@engine/math/Grid';

export const SIM_HZ = 20;

export const WORLD: FlatSize & { seed: number } = {
  cols: 46,
  rows: 46,
  seed: 20261019,
};

export const CAMERA = {
  /** 俯视角：看得见建筑立面，又看得见屋顶与地板 */
  pitchDeg: 50,
  yawDeg: 45,
  /** 竖屏时短边（宽）期望看到的格数 */
  tilesAcross: 11,
  minTilesAcross: 6,
  maxTilesAcross: 30,
};

export type TerrainType = 'grass' | 'sand' | 'rock' | 'water' | 'vein';

export interface TerrainSpec {
  label: string;
  /** 平铺地块的基色 */
  color: number;
  /** 地块厚度，制造 2.5D 的起伏感 */
  thickness: number;
  buildable: boolean;
  /** 人走得过去吗。和 buildable 是两件事：晶脉能站人但不能盖楼，岩脊两者都不行 */
  standable: boolean;
  /** 行走与视野阻挡 */
  blocksSight: boolean;
  /** 盖上去会毁掉这份资源，需要先过一道确认弹窗 */
  destructible?: boolean;
}

export const TERRAIN: Record<TerrainType, TerrainSpec> = {
  grass: { label: '草原', color: 0x6f9a52, thickness: 0.5, buildable: true, standable: true, blocksSight: false },
  sand: { label: '沙地', color: 0xc2ab74, thickness: 0.46, buildable: true, standable: true, blocksSight: false },
  rock: { label: '岩脊', color: 0x7d8595, thickness: 0.78, buildable: false, standable: false, blocksSight: true },
  water: { label: '水域', color: 0x2f6f96, thickness: 0.3, buildable: false, standable: false, blocksSight: false },
  vein: {
    label: '晶脉',
    color: 0x6c5aa6,
    thickness: 0.56,
    buildable: true,
    standable: true,
    blocksSight: false,
    destructible: true,
  },
};

export const TERRAIN_ORDER: readonly TerrainType[] = ['grass', 'sand', 'rock', 'water', 'vein'];

/** 这一格人站得住吗（集合旗落点、士兵寻路共用这一处判据）。 */
export const isStandable = (terrain: TerrainType): boolean => TERRAIN[terrain].standable;

/**
 * 采矿的物理模型 —— 产量不是凭空给的加成，而是"小人跑一趟要多久"算出来的：
 *
 *   每秒趟数 = 脚程速度 ÷ (往返格数)      往返 = 2 × 直线格数
 *   每秒产出 = 每秒趟数 × 每趟载重
 *
 * 所以同一栋楼，矿越远产得越少；走得快的楼（精炼厂）在同样距离下就是高产。
 * 一格晶脉同一时刻只允许被一栋楼包工，否则两个矿井挤一个矿点会白送产量。
 */
export const VEIN_WORK = {
  /** 超出这个格数就不派人了（切比雪夫距离，跟占地/邻接一个口径） */
  reach: 7,
  /** 最近也省不掉的那点开销：装卸、排队。分母下限，避免 d=0 时产量爆炸 */
  overheadTiles: 1,
  /** 被压掉之后地块变成什么：开采过的裸土 */
  ruinedTerrain: 'sand' as TerrainType,
};

export const RESOURCE_META = {
  gold: { label: '金币', color: 0xffd36b },
  crystal: { label: '晶钻', color: 0x7cd8ff },
  bread: { label: '面包', color: 0xd9a066 },
} as const;

export type ResourceId = keyof typeof RESOURCE_META;

export const ECONOMY = {
  /** 开局底储：够一次十连（540）+ 一座田庄，第一眼就能把主循环跑通 */
  starting: { gold: 320, crystal: 640, bread: 4 } as Record<ResourceId, number>,
  basePopulationCap: 6,
};

/**
 * 面包与人口都是**容积**，不是每回合往上涨的产量 ——
 * 房屋被拆光之后人口容量会当场掉下去，玩家得再抽到房屋才补得回来。
 * 但"掉下去"这件事只在回合结算那一刻生效（见 ROUNDS），回合中途照旧好用。
 */
export const BREAD = {
  /** 底子上限：没磨坊也能囤一点，免得第一栋房都盖不起 */
  baseCap: 6,
  /** 每座磨坊多囤 6 个 */
  capPerMill: 6,
  /** 主城每回合白送的面包（"默认给你一些面包"） */
  perRoundFromHall: 2,
  /** 磨坊自己每回合的底产，以及每块邻接田地再加一点 */
  perRoundPerMill: 1,
  perRoundPerAdjacentField: 1,
  /** 一栋民居要 1 个面包才盖得起来 */
};

/** 回合节奏。准备阶段什么都不涨，敌人清完（或超时）才结算一次。 */
export const ROUNDS = {
  prepSeconds: 60,
  /** 敌人清光之后至少让 raid 走这么久，免得一波秒没了一回合空转 */
  raidMinSeconds: 6,
  /** raid 拖过这么久就强制结算，免得一只敌人卡住整回合不入账 */
  raidMaxSeconds: 90,
  /** 每回合的敌人波数 */
  wavesPerRound: 1,
  maxRaidUnits: 40,
};

/**
 * 小人视觉参数。素材一帧是 16x24 像素，卡片宽高比由素材决定，
 * 这里只定"站多高"——0.82 大约是"比一格矮一点、又压得住 2x2 建筑"的读数。
 */
export const DUDE = {
  heightTiles: 0.82,
  /** 一个小人上限：矿脉多时不至于把 draw call 顶爆 */
  maxRunners: 48,
};

export const UI = {
  /** 竖屏底部坞的高度上限，超过它会挤压战场视野 */
  dockMaxHeightPx: 96,
};
