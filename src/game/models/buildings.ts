/**
 * 建筑模型说明书 —— 每种建筑一份，全部用套件原语拼出。
 *
 * 约定：局部原点是占地中心、底面 y=0；视觉尺寸略小于占地，俯视角才看得出格子缝隙。
 * 尺寸一律写成数组：box([w,h,d]) / cyl([rTop,rBottom,h]) / cone([r,h]) / crystal([r,h])。
 */

import { PAL, box, cone, crystal, cyl, plinth, prism, sphere, type ModelSpec } from './kit';

/** 2x2 占地的外框宽度（占 2.0 世界单位，留 0.18 的缝）。 */
const S = 1.82;
const S2 = 1.6;

export const house: ModelSpec = [
  plinth([0.94, 0.12, 0.94], PAL.stoneDark, [0, 0, 0]),
  box([0.74, 0.56, 0.74], PAL.wallLight, [0, 0.12, 0]),
  prism([0.96, 0.4, 0.9], PAL.roofRed, [0, 0.68, 0]),
  cyl([0.06, 0.07, 0.28], PAL.wallDark, [0.24, 0.86, -0.18], 6),
];

export const hall: ModelSpec = [
  plinth([S, 0.2, S], PAL.stoneDark, [0, 0, 0]),
  box([S2, 0.92, S2], PAL.wallLight, [0, 0.2, 0]),
  box([S2 * 1.04, 0.1, S2 * 1.04], PAL.wallMid, [0, 1.06, 0]),
  prism([S, 0.62, S * 0.9], PAL.roofGold, [0, 1.11, 0]),
  // 四角立柱：正对镜头时给立面一点节奏
  cyl([0.08, 0.09, 1.0], PAL.wallDark, [-S2 / 2, 0.7, -S2 / 2], 6),
  cyl([0.08, 0.09, 1.0], PAL.wallDark, [S2 / 2, 0.7, -S2 / 2], 6),
  cyl([0.08, 0.09, 1.0], PAL.wallDark, [-S2 / 2, 0.7, S2 / 2], 6),
  cyl([0.08, 0.09, 1.0], PAL.wallDark, [S2 / 2, 0.7, S2 / 2], 6),
  // 顶端晶核：一眼认出"这是主建筑"
  crystal([0.18, 0.5], PAL.glow, [0, 1.78, 0], {
    emissive: PAL.glow,
    emissiveIntensity: 0.7,
    rough: 0.25,
  }),
];

export const barracks: ModelSpec = [
  plinth([S, 0.16, S], PAL.stoneDark, [0, 0, 0]),
  box([S2, 0.78, 1.24], PAL.wallMid, [0, 0.16, 0]),
  prism([S2 * 1.1, 0.44, 1.44], PAL.roofBlue, [0, 0.94, 0]),
  box([0.42, 0.5, 0.1], PAL.woodDark, [0, 0.25, 0.72]),
  // 旗杆 + 三角旗：兵营的识别符
  cyl([0.035, 0.045, 1.25], PAL.woodDark, [-0.78, 0.62, 0.66], 5),
  cone([0.17, 0.3], PAL.roofRed, [-0.78, 1.35, 0.66], 6),
  cyl([0.035, 0.045, 1.25], PAL.woodDark, [0.78, 0.62, 0.66], 5),
  cone([0.17, 0.3], PAL.roofRed, [0.78, 1.35, 0.66], 6),
];

export const farm: ModelSpec = [
  plinth([S, 0.1, S], PAL.woodDark, [0, 0, 0]),
  box([0.9, 0.52, 0.82], PAL.wallLight, [-0.32, 0.1, -0.24]),
  // prism 的 at 是**底面**：墙顶在 0.1+0.52/2=0.36，屋顶就得从 0.36 起
  // （原来写 0.62 是按中心锚点放的，屋顶浮在墙上 0.22）
  prism([1.08, 0.36, 1.0], PAL.roofRed, [-0.32, 0.36, -0.24]),
  // 田垄：三道长条，俯视角下"这是农田"的读图关键
  box([0.86, 0.09, 0.14], PAL.grassTuft, [0.36, 0.1, 0.42]),
  box([0.86, 0.09, 0.14], PAL.grassTuft, [0.36, 0.1, 0.14]),
  box([0.86, 0.09, 0.14], PAL.grassTuft, [0.36, 0.1, -0.14]),
  // 草垛
  sphere(0.2, PAL.wallMid, [0.6, 0.3, 0.44], 1),
  cone([0.16, 0.26], PAL.wood, [0.6, 0.55, 0.44], 6),
];

export const mine: ModelSpec = [
  // 裙：2×2 的楼落在"占地内最高那块"上，真图最大落差 0.100，
  // 底面不探到 -0.10 以下的话，矮的那几格上面就是一条漏光的缝（看着像悬空）
  box([0.86, 0.18, 0.86], PAL.stoneDark, [0, -0.09, 0]),
  plinth([S, 0.12, S], PAL.stoneDark, [0, 0, 0]),
  // 井架：四腿 + 顶棚，剪影一眼是矿
  cyl([0.055, 0.07, 1.05], PAL.woodDark, [-0.5, 0.52, -0.5], 5),
  cyl([0.055, 0.07, 1.05], PAL.woodDark, [0.5, 0.52, -0.5], 5),
  cyl([0.055, 0.07, 1.05], PAL.woodDark, [-0.5, 0.52, 0.5], 5),
  cyl([0.055, 0.07, 1.05], PAL.woodDark, [0.5, 0.52, 0.5], 5),
  prism([1.5, 0.34, 1.3], PAL.roofBlue, [0, 1.05, 0]),
  box([0.7, 0.34, 0.5], PAL.stone, [0, 0.28, 0]),
  crystal([0.13, 0.34], PAL.crystal, [0, 0.62, 0], {
    emissive: PAL.crystal,
    emissiveIntensity: 0.55,
  }),
];

export const market: ModelSpec = [
  box([0.86, 0.18, 0.86], PAL.stoneDark, [0, -0.09, 0]), // 裙，同矿井那条：挡住 0.100 的厚度落差
  plinth([S, 0.14, S], PAL.stoneDark, [0, 0, 0]),
  // 三顶摊位伞：圆顶盖比斜屋顶更像市集
  cyl([0.02, 0.02, 0.62], PAL.woodDark, [-0.5, 0.5, -0.4], 5),
  cone([0.36, 0.26], PAL.roofGold, [-0.5, 0.86, -0.4], 8),
  cyl([0.02, 0.02, 0.62], PAL.woodDark, [0.5, 0.5, -0.3], 5),
  cone([0.36, 0.26], PAL.roofRed, [0.5, 0.86, -0.3], 8),
  cyl([0.02, 0.02, 0.62], PAL.woodDark, [-0.05, 0.5, 0.5], 5),
  cone([0.36, 0.26], PAL.roofBlue, [-0.05, 0.86, 0.5], 8),
  box([0.5, 0.22, 0.34], PAL.wallMid, [-0.5, 0.24, -0.4]),
  box([0.5, 0.22, 0.34], PAL.wallMid, [0.5, 0.24, -0.3]),
  box([0.5, 0.22, 0.34], PAL.wallMid, [-0.05, 0.24, 0.5]),
];

export const tower: ModelSpec = [
  plinth([0.9, 0.14, 0.9], PAL.stoneDark, [0, 0, 0]),
  cyl([0.3, 0.4, 1.25], PAL.stone, [0, 0.14, 0], 8),
  box([0.74, 0.16, 0.74], PAL.wallMid, [0, 1.42, 0]),
  cone([0.46, 0.62], PAL.roofBlue, [0, 1.72, 0], 8),
  crystal([0.08, 0.2], PAL.glow, [0, 2.06, 0], { emissive: PAL.glow, emissiveIntensity: 0.9 }),
];

export const refinery: ModelSpec = [
  plinth([S, 0.18, S], PAL.stoneDark, [0, 0, 0]),
  box([1.3, 0.72, 1.1], PAL.metal, [-0.16, 0.18, 0], { metal: 0.5, rough: 0.5 }),
  prism([1.44, 0.3, 1.24], PAL.stone, [-0.16, 0.9, 0]),
  // 排烟管
  cyl([0.11, 0.13, 0.9], PAL.wallDark, [0.62, 0.62, -0.45], 6),
  cyl([0.11, 0.13, 0.9], PAL.wallDark, [0.62, 0.62, 0.45], 6),
  crystal([0.26, 0.72], PAL.crystal, [0.62, 0.18, 0], {
    emissive: PAL.crystal,
    emissiveIntensity: 0.75,
    rough: 0.2,
  }),
];

/** 弓手营：矮棚 + 箭靶 + 一捆箭。识别符是那块圆靶。 */
export const archery: ModelSpec = [
  plinth([S, 0.12, S], PAL.stoneDark, [0, 0, 0]),
  box([1.1, 0.5, 1.0], PAL.wallLight, [-0.22, 0.12, 0]),
  prism([1.26, 0.34, 1.16], PAL.roofRed, [-0.22, 0.62, 0]),
  // 箭靶：圆盘立在一根杆上，俯视角也能认出是个靶
  cyl([0.03, 0.035, 0.6], PAL.woodDark, [0.6, 0.42, 0.1], 5),
  cyl([0.24, 0.24, 0.06], PAL.snow, [0.6, 0.74, 0.1], 10),
  cyl([0.1, 0.1, 0.07], PAL.roofRed, [0.6, 0.745, 0.1], 10),
  // 箭捆
  cyl([0.05, 0.06, 0.34], PAL.wood, [0.24, 0.3, -0.6], 6),
  cyl([0.05, 0.06, 0.34], PAL.wood, [0.4, 0.3, -0.58], 6),
  cyl([0.05, 0.06, 0.34], PAL.wood, [0.32, 0.3, -0.44], 6),
];

/** 兽穴：半埋的石窝 + 图腾角。剪影故意和人的房子不一样。 */
export const warren: ModelSpec = [
  plinth([S * 0.9, 0.1, S * 0.9], PAL.stoneDark, [0, 0, 0]),
  sphere(0.62, PAL.stone, [0, 0.14, 0], 1),
  // 洞口
  cyl([0.26, 0.26, 0.5], PAL.wallDark, [0, 0.2, 0.42], 8),
  // 两根图腾角：兽族的读图关键
  cone([0.14, 0.7], PAL.snow, [-0.62, 0.5, -0.5], 6),
  cone([0.12, 0.56], PAL.snow, [-0.44, 0.42, -0.66], 6),
  box([0.5, 0.1, 0.36], PAL.woodDark, [0.52, 0.12, -0.4]),
];

/** 神龛：白石小殿 + 一根发光顶芯，远远看就知道是奶人的地方。 */
export const temple: ModelSpec = [
  plinth([S * 0.9, 0.16, S * 0.9], PAL.snow, [0, 0, 0]),
  box([1.06, 0.66, 1.06], PAL.wallLight, [0, 0.16, 0]),
  cone([0.86, 0.62], PAL.roofGold, [0, 0.94, 0], 4),
  cyl([0.06, 0.07, 0.8], PAL.wallMid, [-0.44, 0.5, -0.44], 6),
  cyl([0.06, 0.07, 0.8], PAL.wallMid, [0.44, 0.5, -0.44], 6),
  cyl([0.06, 0.07, 0.8], PAL.wallMid, [-0.44, 0.5, 0.44], 6),
  cyl([0.06, 0.07, 0.8], PAL.wallMid, [0.44, 0.5, 0.44], 6),
  crystal([0.13, 0.36], PAL.glow, [0, 1.6, 0], { emissive: PAL.glow, emissiveIntensity: 0.75 }),
];

/** 磨坊：石塔 + 四片帆板。剪影一眼是"磨东西的"，也是面包的仓。 */
export const mill: ModelSpec = [
  plinth([S, 0.14, S], PAL.stoneDark, [0, 0, 0]),
  cyl([0.42, 0.56, 1.1], PAL.wallLight, [0, 0.14, 0], 8),
  cone([0.56, 0.44], PAL.roofRed, [0, 1.34, 0], 8),
  // 四片帆板：十字加中心轴
  cyl([0.05, 0.05, 0.9], PAL.woodDark, [0, 1.62, 0], 6),
  box([0.9, 0.1, 0.16], PAL.wood, [0, 1.62, 0]),
  box([0.16, 0.1, 0.9], PAL.wood, [0, 1.62, 0]),
  box([0.34, 0.2, 0.3], PAL.wallDark, [0.3, 0.24, 0.5]),
];

/** 田地：一垄一垄的矮埂 + 四角木桩。和 farm 的区别是不带房子。 */
export const field: ModelSpec = [
  plinth([0.96, 0.06, 0.96], PAL.woodDark, [0, 0, 0]),
  box([0.86, 0.1, 0.14], PAL.grassTuft, [0, 0.1, 0.32]),
  box([0.86, 0.1, 0.14], PAL.grassTuft, [0, 0.1, 0]),
  box([0.86, 0.1, 0.14], PAL.grassTuft, [0, 0.1, -0.32]),
  cyl([0.04, 0.05, 0.3], PAL.wood, [0.42, 0.18, 0.42], 5),
  cyl([0.04, 0.05, 0.3], PAL.wood, [-0.42, 0.18, -0.42], 5),
];

/** 箭塔：木台 + 围堞 + 一面斜顶。1x1 占地，所以整体压得窄。 */
export const arrowTower: ModelSpec = [
  plinth([0.86, 0.12, 0.86], PAL.stoneDark, [0, 0, 0]),
  cyl([0.34, 0.42, 0.9], PAL.stone, [0, 0.12, 0], 8),
  box([0.72, 0.16, 0.72], PAL.wallMid, [0, 1.06, 0]),
  // 四角垛口
  box([0.14, 0.2, 0.14], PAL.wallDark, [0.28, 1.24, 0.28]),
  box([0.14, 0.2, 0.14], PAL.wallDark, [-0.28, 1.24, 0.28]),
  box([0.14, 0.2, 0.14], PAL.wallDark, [0.28, 1.24, -0.28]),
  box([0.14, 0.2, 0.14], PAL.wallDark, [-0.28, 1.24, -0.28]),
  cone([0.44, 0.4], PAL.roofRed, [0, 1.5, 0], 6),
];

/** 炮塔：矮粗石堡 + 一根朝外的铁炮管。炮管是它的识别符。 */
export const cannonTower: ModelSpec = [
  plinth([0.92, 0.16, 0.92], PAL.stoneDark, [0, 0, 0]),
  box([0.7, 0.72, 0.7], PAL.stone, [0, 0.16, 0]),
  box([0.82, 0.12, 0.82], PAL.wallDark, [0, 0.9, 0]),
  // 炮管：横出一截，口子上一个铁环。原语不带旋转参数，这里直接写说明书
  { part: { kind: 'cyl', rTop: 0.11, rBottom: 0.13, height: 0.66, seg: 8 }, color: PAL.metal, at: [0, 0.66, 0.5], rot: [Math.PI / 2, 0, 0] },
  { part: { kind: 'cyl', rTop: 0.15, rBottom: 0.15, height: 0.08, seg: 8 }, color: PAL.wallDark, at: [0, 0.66, 0.82], rot: [Math.PI / 2, 0, 0] },
  sphere(0.13, PAL.wallDark, [0.26, 1.06, -0.26], 1),
];

/** 魔法塔：细高石塔 + 顶端悬浮晶核，夜里靠它当地标。 */
export const magicTower: ModelSpec = [
  plinth([0.84, 0.14, 0.84], PAL.stoneDark, [0, 0, 0]),
  cyl([0.24, 0.4, 1.24], PAL.wallLight, [0, 0.14, 0], 8),
  cone([0.36, 0.5], PAL.roofBlue, [0, 1.46, 0], 8),
  crystal([0.16, 0.4], PAL.glow, [0, 2.02, 0], { emissive: PAL.glow, emissiveIntensity: 0.85 }),
  // 环着塔身的一道符带：塔身顶在 0.76，带子得套在身上（0.92 时它是浮在空中的）
  cyl([0.3, 0.3, 0.06], PAL.crystal, [0, 0.6, 0], 8),
];

/** 工地骨架：建造期间盖在格子上，配合模型逐渐"长出来"读作进度。 */
export const scaffold: ModelSpec = [
  plinth([S, 0.06, S], PAL.woodDark, [0, 0, 0]),
  // 立柱按"中心"锚点放：高 0.9 → 0.45 才正好从底盘(顶 0.06)立到横杆(0.82..0.90)
  // 原来写的 0.06 是按底面锚点算的，结果柱顶只到 0.51，两道横杆浮在头顶 0.31 处
  cyl([0.05, 0.06, 0.9], PAL.wood, [-0.75, 0.45, -0.75], 5),
  cyl([0.05, 0.06, 0.9], PAL.wood, [0.75, 0.45, -0.75], 5),
  cyl([0.05, 0.06, 0.9], PAL.wood, [-0.75, 0.45, 0.75], 5),
  cyl([0.05, 0.06, 0.9], PAL.wood, [0.75, 0.45, 0.75], 5),
  box([1.62, 0.07, 0.12], PAL.wood, [0, 0.86, -0.75]),
  box([1.62, 0.07, 0.12], PAL.wood, [0, 0.86, 0.75]),
];

export const buildingModels: Record<string, ModelSpec> = {
  house,
  hall,
  barracks,
  archery,
  warren,
  temple,
  mill,
  field,
  arrowTower,
  cannonTower,
  magicTower,
  farm,
  mine,
  market,
  tower,
  refinery,
  scaffold,
};
