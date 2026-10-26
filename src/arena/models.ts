/**
 * 对战模式的建筑模型 —— **纯数据**（不 import three、不 import 任何东西）。
 *
 * 这样做有两个好处：
 * 1. `ArenaApp` 用套件的 `buildModel(spec)` 把它变成 three 的 Group；
 * 2. `tools/preview_models.mjs` 能在 node 里直接 import 这份数据、按**真实比例**投成 PNG
 *    —— 改模型的人在给他看之前就能先看见，不再盲改。
 *
 * 坐标约定与 `game/models/kit.ts` 完全一致（不是另起一套）：
 * - box / cyl / cone / sphere / crystal 的 `at` 是**中心**；
 * - prism / plinth 的 `at` 是**底面**。
 * 所以纵向位置一律用 `mid(底, 高)` 写，别手算中心点。
 *
 * 单位是**模型单位**，进游戏时整组乘 `BUILDING_SCALE`（2.2）。注释里写的"格"都是乘完的值。
 * 设计语言（详见 docs/工作笔记/模型重做计划_20261027.md）：
 * - 3×3 占地，模型视觉宽 2.5–4.0 格，不再像上一版那样屋顶比占地宽一倍；
 * - 每栋一个**唯一剪影**：核心=尖顶+水晶、兵营=双坡脊+门、箭塔=垛口+锥顶、炮塔=圆台+炮管、磨坊=四扇帆；
 * - **阵营色只出现在小面积**（旗、炮塔四角、核心水晶、磨坊顶盖）；
 * - 每栋 ≤14 个原语。
 */

export type Vec3 = readonly [number, number, number];

export interface PaintOptions {
  rough?: number;
  metal?: number;
  emissive?: number;
  emissiveIntensity?: number;
  opacity?: number;
  flat?: boolean;
}

export type Part =
  | { kind: 'box'; size: Vec3 }
  | { kind: 'prism'; size: Vec3 }
  | { kind: 'cyl'; rTop: number; rBottom: number; height: number; seg?: number }
  | { kind: 'cone'; radius: number; height: number; seg?: number }
  | { kind: 'sphere'; radius: number; seg?: number }
  | { kind: 'crystal'; radius: number; height: number }
  | { kind: 'plinth'; size: Vec3 };

export interface Node {
  part: Part;
  color: number;
  at?: Vec3;
  rot?: Vec3;
  paint?: PaintOptions;
  /** 绕 `pivot` 自转（弧度/秒，绕 Z）：磨坊的帆。套件按这个字段建转轴 Group。 */
  spin?: number;
  pivot?: Vec3;
  /** 可转炮台：带这个字段的件收进同一个转台，轴心就是这个坐标。 */
  turret?: Vec3;
}

/** 建筑族调色板：只在这里改颜色。 */
export const ARENA_PAL = {
  stone: 0x6a6f7c,
  stoneDark: 0x4c515c,
  wall: 0xc9b795,
  wallDark: 0x9d8b6b,
  roof: 0xa8483c,
  roofDark: 0x7d342c,
  wood: 0x6b4526,
  woodLight: 0x9a6b3f,
  iron: 0x3b4250,
  gold: 0xc8a24c,
} as const;

// ---------------------------------------------------------------- 原语（与套件同名同锚点）

/** box / cyl / cone / crystal 的 `at` 是中心：给"底面 + 高"，回中心高度。 */
const mid = (bottom: number, height: number): number => bottom + height / 2;

const box = (size: Vec3, color: number, at: Vec3 = [0, 0, 0], paint?: PaintOptions): Node => ({
  part: { kind: 'box', size },
  color,
  at,
  paint,
});

/** prism / plinth 的 `at` 是底面，直接写它坐落的那个高度。 */
const prism = (size: Vec3, color: number, at: Vec3 = [0, 0, 0]): Node => ({
  part: { kind: 'prism', size },
  color,
  at,
});

const plinth = (size: Vec3, color: number, at: Vec3 = [0, 0, 0]): Node => ({
  part: { kind: 'plinth', size },
  color,
  at,
});

const cyl = (size: readonly [number, number, number], color: number, at: Vec3 = [0, 0, 0], seg = 8): Node => ({
  part: { kind: 'cyl', rTop: size[0], rBottom: size[1], height: size[2], seg },
  color,
  at,
});

const cone = (radius: number, height: number, color: number, at: Vec3 = [0, 0, 0], seg = 8): Node => ({
  part: { kind: 'cone', radius, height, seg },
  color,
  at,
});

const sphere = (radius: number, color: number, at: Vec3 = [0, 0, 0], seg = 1): Node => ({
  part: { kind: 'sphere', radius, seg },
  color,
  at,
});

const crystal = (radius: number, height: number, color: number, at: Vec3 = [0, 0, 0]): Node => ({
  part: { kind: 'crystal', radius, height },
  color,
  at,
  paint: { emissive: color, emissiveIntensity: 0.9, rough: 0.25 },
});

// ---------------------------------------------------------------- 五栋楼

/**
 * 议事厅（核心）：石台 + 石裙 + 方墙 + 四角柱 + 四坡顶 + **嵌在屋顶尖上的水晶**。
 * 剪影：**方塔 + 大尖顶 + 一颗水晶**。宽 3.8–4.0 格，高 6.2 格。
 */
export function coreModel(accent: number): Node[] {
  return [
    plinth([1.8, 0.07, 1.8], ARENA_PAL.stoneDark),
    // 下重上轻的两段式：石砌的宽底座 + 收进去的浅色墙身，比一个方块更像"主楼"
    box([1.7, 0.5, 1.7], ARENA_PAL.stone, [0, mid(0.07, 0.5), 0]),
    box([1.32, 1.0, 1.32], ARENA_PAL.wall, [0, mid(0.57, 1.0), 0]),
    // 门开在石座上，门前一级石阶
    box([0.34, 0.42, 0.07], ARENA_PAL.wood, [0, mid(0.07, 0.42), 0.86]),
    box([0.44, 0.06, 0.08], ARENA_PAL.gold, [0, 0.54, 0.87]),
    box([0.5, 0.12, 0.18], ARENA_PAL.stone, [0, mid(0.07, 0.12), 0.97]),
    // 四角柱：把墙身的四条棱压出来
    cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [-0.66, mid(0.57, 1.05), -0.66], 6),
    cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [0.66, mid(0.57, 1.05), -0.66], 6),
    cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [-0.66, mid(0.57, 1.05), 0.66], 6),
    cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [0.66, mid(0.57, 1.05), 0.66], 6),
    box([1.4, 0.09, 1.4], ARENA_PAL.wallDark, [0, mid(1.57, 0.09), 0]),
    // 檐板 + 四坡顶（cone 4 段转 45° = 与墙对齐的金字塔，宽 1.78 = 3.9 格）
    box([1.74, 0.06, 1.74], ARENA_PAL.roofDark, [0, mid(1.66, 0.06), 0]),
    {
      part: { kind: 'cone', radius: 1.22, height: 0.66, seg: 4 },
      color: ARENA_PAL.roof,
      at: [0, mid(1.72, 0.66), 0],
      rot: [0, Math.PI / 4, 0],
    },
    // 水晶：下半截埋在屋顶里，上半截露出来当尖顶（不是飘在头顶的一块）
    crystal(0.2, 0.62, accent, [0, mid(2.28, 0.62), 0]),
  ];
}

/**
 * 兵营：石脚 + 长屋 + 双坡脊 + 大门 + 檐柱 + 兵器架。
 * 剪影：**横着的长脊**，全场最矮（3.0 格）—— 远看就知道是营房不是塔。
 */
export function barracksModel(): Node[] {
  return [
    plinth([1.5, 0.06, 1.16], ARENA_PAL.stoneDark),
    box([1.45, 0.16, 1.02], ARENA_PAL.stoneDark, [0, mid(0.06, 0.16), 0]),
    box([1.42, 0.62, 0.98], ARENA_PAL.wall, [0, mid(0.22, 0.62), 0]),
    prism([1.62, 0.5, 1.14], ARENA_PAL.roof, [0, 0.84, 0]),
    box([1.64, 0.05, 0.1], ARENA_PAL.roofDark, [0, mid(1.32, 0.05), 0]),
    box([0.34, 0.46, 0.06], ARENA_PAL.wood, [0, mid(0.22, 0.46), 0.52]),
    box([0.44, 0.05, 0.07], ARENA_PAL.woodLight, [0, 0.7, 0.52]),
    // 檐柱：门口两根，给正脸一点纵深
    cyl([0.035, 0.04, 0.6], ARENA_PAL.wood, [-0.62, mid(0.22, 0.6), 0.46], 5),
    cyl([0.035, 0.04, 0.6], ARENA_PAL.wood, [0.62, mid(0.22, 0.6), 0.46], 5),
    // 兵器架：三格之外仍看得出的"兵营"符号
    cyl([0.022, 0.026, 0.9], ARENA_PAL.woodLight, [0.55, mid(0.06, 0.9), 0.62], 5),
    cyl([0.022, 0.026, 0.9], ARENA_PAL.woodLight, [0.64, mid(0.06, 0.9), 0.64], 5),
    box([0.14, 0.04, 0.04], ARENA_PAL.iron, [0.595, 0.66, 0.63]),
  ];
}

/**
 * 箭塔：细高石鼓 + 腰线 + **外挑垛口** + 三面箭窗 + 压在垛口上的锥顶。
 * 剪影：**全场最高（6.1 格）+ 顶上四个齿**。用户点名要重做的就是它。
 */
export function arrowTowerModel(): Node[] {
  return [
    plinth([1.12, 0.06, 1.12], ARENA_PAL.stoneDark),
    // 塔身：下半截石砌、上半截抹灰（暖色），否则整根灰柱子看不出层次
    cyl([0.5, 0.6, 0.5], ARENA_PAL.stone, [0, mid(0.06, 0.5), 0], 10),
    cyl([0.52, 0.56, 1.05], ARENA_PAL.wall, [0, mid(0.56, 1.05), 0], 10),
    cyl([0.58, 0.58, 0.07], ARENA_PAL.stoneDark, [0, mid(1.61, 0.07), 0], 10),
    // 外挑的垛口台：比塔身宽一圈，四个齿才站得住
    cyl([0.68, 0.55, 0.22], ARENA_PAL.stone, [0, mid(1.68, 0.22), 0], 10),
    box([0.22, 0.3, 0.22], ARENA_PAL.stone, [-0.5, mid(1.9, 0.3), -0.5]),
    box([0.22, 0.3, 0.22], ARENA_PAL.stone, [0.5, mid(1.9, 0.3), -0.5]),
    box([0.22, 0.3, 0.22], ARENA_PAL.stone, [-0.5, mid(1.9, 0.3), 0.5]),
    box([0.22, 0.3, 0.22], ARENA_PAL.stone, [0.5, mid(1.9, 0.3), 0.5]),
    // 三面箭窗：贴在鼓身外皮上
    box([0.09, 0.3, 0.05], ARENA_PAL.stoneDark, [0, mid(1.0, 0.3), 0.545]),
    box([0.05, 0.3, 0.09], ARENA_PAL.stoneDark, [0.545, mid(1.0, 0.3), 0]),
    box([0.05, 0.3, 0.09], ARENA_PAL.stoneDark, [-0.545, mid(1.0, 0.3), 0]),
    // 锥顶从垛口台面上长起来、穿过四个齿：远看是"塔顶长出一个尖"，
    // 而不是上一版那种"尖顶旁边飘着四块石头"
    cone(0.5, 0.8, ARENA_PAL.roof, [0, mid(1.9, 0.8), 0], 8),
    sphere(0.06, ARENA_PAL.gold, [0, 2.74, 0], 1),
  ];
}

/**
 * 炮塔：方座 + 圆台 + 四角**防撞块**（阵营色）+ 可转炮台 + 粗炮管。
 * 剪影：**矮胖 + 一根横着的炮管**（2.9 格高，和箭塔一眼分得开）。
 */
export function cannonTowerModel(accent: number): Node[] {
  const PIVOT: Vec3 = [0, 0.86, 0];
  const bumper = (x: number, z: number): Node =>
    box([0.22, 0.22, 0.22], accent, [x, mid(0.86, 0.22), z], {
      emissive: accent,
      emissiveIntensity: 0.3,
      rough: 0.55,
    });
  return [
    plinth([1.42, 0.06, 1.42], ARENA_PAL.stoneDark),
    // 两级石座：下宽上窄，给炮台一个"肩膀"；台面换成木栈道，和石身分色
    box([1.32, 0.36, 1.32], ARENA_PAL.stoneDark, [0, mid(0.06, 0.36), 0]),
    box([1.2, 0.34, 1.2], ARENA_PAL.stone, [0, mid(0.42, 0.34), 0]),
    cyl([0.58, 0.62, 0.1], ARENA_PAL.wood, [0, mid(0.76, 0.1), 0], 10),
    bumper(-0.46, -0.46),
    bumper(0.46, -0.46),
    bumper(-0.46, 0.46),
    bumper(0.46, 0.46),
    // ↓ 转台：炮盘 + 炮座 + 炮管 + 炮口箍，全部绕同一个轴心
    { ...cyl([0.3, 0.34, 0.16], ARENA_PAL.iron, [0, mid(0.86, 0.16), 0], 8), turret: PIVOT },
    { ...box([0.44, 0.28, 0.44], ARENA_PAL.iron, [0, mid(1.02, 0.28), 0]), turret: PIVOT },
    // 炮管朝 +X：视图里 yaw = -aim 就能对准目标（口径沿用上一版，别改朝向）
    {
      part: { kind: 'cyl', rTop: 0.11, rBottom: 0.14, height: 0.7, seg: 8 },
      color: ARENA_PAL.iron,
      at: [0.5, 1.16, 0],
      rot: [0, 0, -Math.PI / 2],
      turret: PIVOT,
    },
    {
      part: { kind: 'cyl', rTop: 0.17, rBottom: 0.17, height: 0.12, seg: 8 },
      color: ARENA_PAL.stoneDark,
      at: [0.86, 1.16, 0],
      rot: [0, 0, -Math.PI / 2],
      turret: PIVOT,
    },
    // 台面上的弹药箱：不转，给"这炮有后勤"的暗示
    box([0.2, 0.16, 0.18], ARENA_PAL.wood, [0.44, mid(0.86, 0.16), -0.44]),
  ];
}

/**
 * 磨坊：石塔 + 木栈道 + **阵营色顶盖** + 四片帆 + 门。
 * 剪影：**顶上一个大十字帆**。宽 2.8 格，帆展 3.4 格，高 5.4 格。
 */
export function millModel(accent: number): Node[] {
  const PIVOT: Vec3 = [0, 1.5, 0.68];
  const sail = (node: Node): Node => ({ ...node, spin: 1.7, pivot: PIVOT });
  return [
    plinth([1.12, 0.06, 1.12], ARENA_PAL.stoneDark),
    cyl([0.46, 0.62, 1.5], ARENA_PAL.wall, [0, mid(0.06, 1.5), 0], 10),
    // 木栈道：把塔切成"石头在下、木头在上"
    cyl([0.64, 0.64, 0.05], ARENA_PAL.wood, [0, mid(1.28, 0.05), 0], 10),
    box([0.28, 0.46, 0.06], ARENA_PAL.wood, [0, mid(0.06, 0.46), 0.56]),
    cyl([0.64, 0.64, 0.06], ARENA_PAL.roofDark, [0, mid(1.56, 0.06), 0], 10),
    // 顶盖按阵营上色（用户点名："风车顶盖上的颜色是不同的"），做得陡一点才像帽子不像盘子
    { ...cone(0.54, 0.95, accent, [0, mid(1.62, 0.95), 0], 10), paint: { rough: 0.85 } },
    // 轮毂从正面 (+Z) 伸出来，帆板绕着它转
    {
      part: { kind: 'cyl', rTop: 0.07, rBottom: 0.08, height: 0.22, seg: 8 },
      color: ARENA_PAL.iron,
      at: [0, 1.5, 0.6],
      rot: [Math.PI / 2, 0, 0],
    },
    // 十字骨架 + 四片帆。帆都挂在骨架的**同一侧**，转起来才像一片扫过的帆
    sail(box([0.06, 1.7, 0.04], ARENA_PAL.wood, [0, 1.5, 0.68])),
    sail(box([1.7, 0.06, 0.04], ARENA_PAL.wood, [0, 1.5, 0.68])),
    // 四片帆：宽帆盖住骨架，各挂在同一侧 —— 远看是四片大桨，不是一根十字架
    sail(box([0.3, 0.78, 0.03], 0xf2ead8, [0.26, 1.89, 0.68])),
    sail(box([0.78, 0.3, 0.03], 0xf2ead8, [0.39, 1.24, 0.68])),
    sail(box([0.3, 0.78, 0.03], 0xf2ead8, [-0.26, 1.11, 0.68])),
    sail(box([0.78, 0.3, 0.03], 0xf2ead8, [-0.39, 1.76, 0.68])),
  ];
}

/** 名字 → 造模型。视图层只读这张表；`accent` 是阵营色。 */
export const ARENA_MODELS = {
  core: coreModel,
  barracks: barracksModel,
  arrowTower: arrowTowerModel,
  cannonTower: cannonTowerModel,
  mill: millModel,
} as const;

export type ArenaModelName = keyof typeof ARENA_MODELS;

/**
 * 旗子的落点（**格**，不是模型单位）。
 *
 * 上一版把旗挂在 z 为负的那面 —— 那是背对镜头的墙，所以旗子总像"埋进楼里"。
 * 这一版全部放在**镜头这一侧**（z 为正）或屋顶/垛口上：
 * - 核心：前墙、檐口下面（竖旗从杆上垂下，正是他要的"挂在墙上、从上往下"）
 * - 兵营：屋脊两端的任意一端（他点名"放在顶上"）
 * - 箭塔：右前角垛口顶上，旗面在锥顶外侧，不穿屋顶
 * - 炮塔：台座右前角的地面上（炮管转一圈也扫不到这么远）
 * - 磨坊：顶盖右侧（帆在 z 正方向的平面上，不会碰到）
 */
export interface FlagSpot {
  x: number;
  z: number;
  /** 杆底高度（格） */
  base: number;
  /** 杆高（格） */
  pole: number;
}

export const ARENA_FLAGS: Record<ArenaModelName, FlagSpot> = {
  core: { x: 1.7, z: 1.7, base: 0.12, pole: 5.2 },
  barracks: { x: 1.6, z: 0, base: 2.95, pole: 0.9 },
  arrowTower: { x: 1.1, z: 1.1, base: 4.75, pole: 0.85 },
  cannonTower: { x: 1.45, z: 1.45, base: 0.12, pole: 2.1 },
  mill: { x: 0, z: 0, base: 5.6, pole: 0.9 },
};
