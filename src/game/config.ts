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
  /**
   * 磨坊每回合的底产、每块邻接田地的加成。
   *
   * 这两个数**真的在管事**：`buildings.ts` 的 `mill.breadPerRound` 直接读这里。
   * 以前它们是两份各写各的（表里 1/1、这里 1/1），改哪边都不动对方，
   * 而 `tests/rounds.test.ts` 那条锁钉的恰好是这里的数 —— 于是"改表测试不会红"。
   */
  perRoundPerMill: 1,
  perRoundPerAdjacentField: 1,
};

/** 回合节奏。准备阶段什么都不涨，敌人清完（或超时）才结算一次。 */
export const ROUNDS = {
  prepSeconds: 60,
  /** 敌人清光之后至少让 raid 走这么久，免得一波秒没了一回合空转 */
  raidMinSeconds: 6,
  /** raid 拖过这么久就强制结算，免得一只敌人卡住整回合不入账 */
  raidMaxSeconds: 90,
  /** 引擎级硬上限：场上同时多少人，任何一档都不许超过它 */
  maxRaidUnits: 40,
};

/**
 * 三档难度 —— 只动**出兵量**与**怪物 AI**这两类东西。
 *
 * 攻防血造价一律不碰：实测过单发改数值只买到 0~1 回合，而"这波从几处来、
 * 分几涌来、扑哪栋楼、打不打你的兵"这些才是真把手（上一格的对照台量出来的）。
 */
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface RaidProfile {
  label: string;
  /** 第 N 波来几只 = waveBase + waveGrowth × (N-1)，再夹到 capOnField */
  waveBase: number;
  waveGrowth: number;
  /** 场上同时人数上限（不得超过 ROUNDS.maxRaidUnits） */
  capOnField: number;
  /** 一波拆成几组：一组几只、组与组隔几秒进（"慢慢出"就是这一条） */
  burstSize: number;
  burstGapSeconds: number;
  /** 一波从地图几处边缘同时来（简单档的"随机乱出兵"） */
  spawnPoints: number;
  /** 混兵：从第几波起，每 everyN 只塞一只这种兵 */
  mix: { unitId: string; fromRound: number; everyN: number }[];
  /** 选目标时给议事厅减几格距离：0 = 谁近拆谁，越大越直奔心脏 */
  hallBias: number;
  /** 打不打你的兵：远程敌人会不会转头（false = 眼里只有楼） */
  engageTroops: boolean;
  /** 进场时在几格内打散：越大越不容易被一发炮弹一片，也越不像一支军队 */
  scatterTiles: number;
  /**
   * 简单档的"不急"：敌人每打一下之后多站几秒才来第二下。
   * 这是来敌节奏（AI 急不急），不是兵种自己的攻击间隔 —— units 表里那几个 cooldown 一律没动。
   */
  strikePauseSeconds: number;
}

export const DIFFICULTY: Record<Difficulty, RaidProfile> = {
  easy: {
    label: '简单',
    waveBase: 2,
    waveGrowth: 0.5,
    capOnField: 20,
    burstSize: 2,
    burstGapSeconds: 5,
    spawnPoints: 3,
    mix: [
      { unitId: 'shade', fromRound: 8, everyN: 6 },
      { unitId: 'golem', fromRound: 10, everyN: 8 },
    ],
    hallBias: 0,
    engageTroops: false,
    scatterTiles: 2.4,
    strikePauseSeconds: 1.2,
  },
  normal: {
    label: '正常',
    // 第 1 波 4 只（改动前写死的是 5 只）；成长放缓，"一直撑下去"才可能成立
    waveBase: 4,
    waveGrowth: 1.2,
    capOnField: 32,
    burstSize: 4,
    burstGapSeconds: 4,
    spawnPoints: 1,
    mix: [
      { unitId: 'shade', fromRound: 3, everyN: 4 },
      { unitId: 'golem', fromRound: 5, everyN: 6 },
    ],
    hallBias: 2,
    engageTroops: false,
    scatterTiles: 1.2,
    strikePauseSeconds: 0,
  },
  hard: {
    label: '困难',
    waveBase: 6,
    waveGrowth: 2,
    capOnField: 40,
    burstSize: 6,
    burstGapSeconds: 2,
    spawnPoints: 2,
    mix: [
      { unitId: 'shade', fromRound: 2, everyN: 3 },
      { unitId: 'golem', fromRound: 3, everyN: 5 },
    ],
    hallBias: 4,
    engageTroops: true,
    scatterTiles: 0.6,
    strikePauseSeconds: 0,
  },
};

export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

/** 档位的读法只这一处：没给、给错、旧档里没这个字段，一律回到正常。 */
export const difficultyOf = (raw: unknown): Difficulty =>
  raw === 'easy' || raw === 'normal' || raw === 'hard' ? raw : DEFAULT_DIFFICULTY;

/**
 * 小人视觉参数。素材一帧是 16x24 像素，卡片宽高比由素材决定，
 * 这里只定"站多高"——0.82 大约是"比一格矮一点、又压得住 2x2 建筑"的读数。
 */
/** 议事厅派出的工匠：几个、多久补一个、每秒补多少血。 */
export const WORKER = {
  count: 2,
  /** 阵亡后隔几秒补一个 */
  respawnSeconds: 8,
  /** 每个工匠每秒补的血 */
  repairPerSecond: 5,
};

export const DUDE = {
  /**
   * 小人身高（格）。0.82 → 1.12：一格多一点的卡片在默认机位下才看得清脸和动作，
   * 之前 0.82 配上像素素材，缩到一半就只剩一团色块。
   */
  heightTiles: 1.12,
  /** 一个小人上限：矿脉多时不至于把 draw call 顶爆 */
  maxRunners: 48,
};

export const UI = {
  /** 竖屏底部坞的高度上限，超过它会挤压战场视野 */
  dockMaxHeightPx: 96,
};
