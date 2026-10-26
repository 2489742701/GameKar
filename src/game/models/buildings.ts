/**
 * 建筑模型说明书 —— 每种建筑一份，全部用套件原语拼出。
 *
 * 约定：局部原点是占地中心、底面 y=0；视觉尺寸略小于占地，俯视角才看得出格子缝隙。
 * 尺寸一律写成数组：box([w,h,d]) / cyl([rTop,rBottom,h]) / cone([r,h]) / crystal([r,h])。
 * 所有 h 都是**总高**（crystal 的 h 曾经是半高，已按这个口径修掉）。
 */

import { PAL, box, cone, crystal, cyl, flag, plinth, prism, sphere, type ModelSpec, type Node } from './kit';

/** 2x2 占地的外框宽度（占 2.0 世界单位，留 0.18 的缝）。 */
const S = 1.82;
const S2 = 1.6;

/**
 * 埋在土里的基脚。
 *
 * 2×2 的楼落在"占地内最高那块"上，最矮那格就必然露一条缝（实测最大落差 0.100），
 * 所以多格楼的底面必须探到 -0.10 以下。台基是从 0 起算的，光有台基不够 ——
 * 这一层是垫在台基下面的石脚，平时看不见，只在落差处补上那条缝。
 */
const footing = (color: number = PAL.stoneDark): Node => box([1.7, 0.3, 1.7], color, [0, -0.12, 0]);

export const house: ModelSpec = [
  plinth([0.94, 0.12, 0.94], PAL.stoneDark, [0, 0, 0]),
  box([0.74, 0.56, 0.74], PAL.wallLight, [0, 0.12, 0]),
  prism([0.96, 0.4, 0.9], PAL.roofRed, [0, 0.4, 0]),
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
  crystal([0.18, 1.0], PAL.glow, [0, 1.78, 0], {
    emissive: PAL.glow,
    emissiveIntensity: 0.7,
    rough: 0.25,
  }),
];

export const barracks: ModelSpec = [
  footing(),
  plinth([S, 0.16, S], PAL.stoneDark, [0, 0, 0]),
  // 墙：box 的 at 是**中心** ⇒ 坐在台基上就要写 0.16 + 0.78/2 = 0.55
  // （原来写 0.16，墙体整个陷进地里 0.39，屋顶就浮在半空 —— 这一族一共四栋都犯了这个错）
  box([S2, 0.78, 1.24], PAL.wallMid, [0, 0.55, 0]),
  // 屋顶：prism 的 at 是**底面** ⇒ 墙顶 0.94
  prism([S2 * 1.1, 0.44, 1.44], PAL.roofBlue, [0, 0.94, 0]),
  // 门：门框 + 深色门板
  box([0.5, 0.58, 0.08], PAL.woodDark, [0, 0.45, 0.64]),
  box([0.34, 0.46, 0.1], PAL.wood, [0, 0.39, 0.66]),
  // 门前两级台阶（贴地起步，别悬）
  box([0.72, 0.1, 0.16], PAL.stone, [0, 0.05, 0.76]),
  box([0.62, 0.1, 0.12], PAL.stone, [0, 0.15, 0.7]),
  // 兵器架：三杆长矛立在墙外。z 从 0.68 挪到 0.80 —— 屋檐到 ±0.72，
  // 原来插在 0.68 等于从屋面里长出来，矛尖直接穿过瓦面（截图一眼就能看见）
  cyl([0.028, 0.028, 1.0], PAL.wood, [-0.56, 0.62, 0.8], 5),
  cyl([0.028, 0.028, 1.0], PAL.wood, [-0.42, 0.62, 0.82], 5),
  cyl([0.028, 0.028, 1.0], PAL.wood, [-0.28, 0.62, 0.8], 5),
  cone([0.05, 0.16], PAL.metal, [-0.56, 1.2, 0.8], 5),
  cone([0.05, 0.16], PAL.metal, [-0.42, 1.2, 0.82], 5),
  cone([0.05, 0.16], PAL.metal, [-0.28, 1.2, 0.8], 5),
  // 旗杆：插在屋脊两端、往屋外挪一点，杆顶**平的**（不做尖顶/宝顶）。
  // 高度 0.87 是量出来的：杆顶 2.25，比屋脊 1.38 高 0.87 —— 上一版只高 0.66，
  // 旗布下沿正好咬在屋顶的山墙轮廓上，屏幕上看着像"布插进屋顶"。
  // 杆底压在坡面上：z=0.22 处屋面只有 1.24（正脊才 1.38），杆底从 1.20 起 ——
  // 埋进屋面 0.04，既不会飘也不会穿出来（按脊线高度写会悬 0.14）
  cyl([0.035, 0.045, 0.87], PAL.woodDark, [-0.72, 1.635, 0.22], 5),
  cyl([0.035, 0.045, 0.87], PAL.woodDark, [0.72, 1.635, 0.22], 5),
  // 两面旗**朝同一侧飘**（同一阵风）。上一版左旗转了 180°，既有伸展方向相反、
  // 抖动相位也相反，屏幕上就是两股对着吹的风。
  flag([0.46, 0.28], PAL.roofRed, [0.72, 2.07, 0.22]),
  flag([0.46, 0.28], PAL.roofRed, [-0.72, 2.07, 0.22]),
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
  crystal([0.13, 0.68], PAL.crystal, [0, 0.62, 0], {
    emissive: PAL.crystal,
    emissiveIntensity: 0.55,
  }),
];

/**
 * 市集：三顶摊棚 + 台面货。
 *
 * 上一版是"三根 0.02 粗的杆子顶着三把伞"——杆子细到看不见，伞盖就浮在台基上方，
 * 读起来是三朵悬空的蘑菇。现在杆子加粗到 0.045、下沿坐在台基上、伞盖底面压在杆顶，
 * 每摊再加一张柜台和两块货，俯视角下先看见"摊"再看见"伞"。
 */
export const market: ModelSpec = [
  box([0.86, 0.18, 0.86], PAL.stoneDark, [0, -0.09, 0]), // 裙：挡住占地内 0.10 的厚度落差
  plinth([S, 0.14, S], PAL.stone, [0, 0, 0]),
  // 摊 1
  box([0.58, 0.3, 0.36], PAL.wallMid, [-0.5, 0.29, -0.38]),
  cyl([0.045, 0.05, 0.24], PAL.woodDark, [-0.5, 0.56, -0.38], 5),
  cone([0.36, 0.22], PAL.roofGold, [-0.5, 0.79, -0.38], 8),
  box([0.1, 0.07, 0.1], PAL.roofRed, [-0.62, 0.48, -0.36]),
  box([0.1, 0.07, 0.1], PAL.grassTuft, [-0.44, 0.48, -0.4]),
  // 摊 2
  box([0.58, 0.3, 0.36], PAL.wallMid, [0.5, 0.29, -0.3]),
  cyl([0.045, 0.05, 0.24], PAL.woodDark, [0.5, 0.56, -0.3], 5),
  cone([0.36, 0.22], PAL.roofRed, [0.5, 0.79, -0.3], 8),
  box([0.1, 0.07, 0.1], PAL.roofBlue, [0.38, 0.48, -0.32]),
  box([0.1, 0.07, 0.1], PAL.roofGold, [0.56, 0.48, -0.28]),
  // 摊 3
  box([0.58, 0.3, 0.36], PAL.wallMid, [-0.05, 0.29, 0.5]),
  cyl([0.045, 0.05, 0.24], PAL.woodDark, [-0.05, 0.56, 0.5], 5),
  cone([0.36, 0.22], PAL.roofBlue, [-0.05, 0.79, 0.5], 8),
  box([0.1, 0.07, 0.1], PAL.canvas, [-0.17, 0.48, 0.48]),
  box([0.1, 0.07, 0.1], PAL.grassTuft, [0.07, 0.48, 0.52]),
  // 招牌柱：市集的"字"，俯视角下多一根竖线就多一层"这是集市"的信息
  cyl([0.05, 0.06, 0.96], PAL.woodDark, [0.72, 0.62, 0.62], 5),
  box([0.28, 0.16, 0.05], PAL.roofGold, [0.72, 1.02, 0.62]),
];

export const tower: ModelSpec = [
  plinth([0.9, 0.14, 0.9], PAL.stoneDark, [0, 0, 0]),
  cyl([0.3, 0.4, 1.6], PAL.stone, [0, 0.14, 0], 8),
  box([0.74, 0.16, 0.74], PAL.wallMid, [0, 1.02, 0]),
  cone([0.46, 0.62], PAL.roofBlue, [0, 1.41, 0], 8),
  crystal([0.08, 0.4], PAL.glow, [0, 1.82, 0], { emissive: PAL.glow, emissiveIntensity: 0.9 }),
];

export const refinery: ModelSpec = [
  footing(),
  plinth([S, 0.18, S], PAL.stoneDark, [0, 0, 0]),
  // 厂房抬到台基上：0.18 + 0.72/2 = 0.54（原来写 0.18，整栋陷进地里，屋顶浮空）
  box([1.3, 0.72, 1.1], PAL.metal, [-0.16, 0.54, 0], { metal: 0.5, rough: 0.5 }),
  prism([1.44, 0.3, 1.24], PAL.stone, [-0.16, 0.9, 0]),
  // 屋脊压条：给屋顶一道亮边，俯视角下不像一块灰板
  box([1.1, 0.05, 0.1], PAL.wallLight, [-0.16, 1.2, 0]),
  // 排烟管：要高过屋脊才看得出是烟囱，两根之间连一根横管
  cyl([0.11, 0.13, 1.1], PAL.wallDark, [0.66, 0.73, -0.42], 6),
  cyl([0.11, 0.13, 1.1], PAL.wallDark, [0.66, 0.73, 0.42], 6),
  { part: { kind: 'cyl', rTop: 0.06, rBottom: 0.06, height: 0.82, seg: 6 }, color: PAL.metal, at: [0.66, 1.2, 0], rot: [Math.PI / 2, 0, 0] },
  crystal([0.26, 1.8], PAL.crystal, [0.7, 0.27, 0], {
    emissive: PAL.crystal,
    emissiveIntensity: 0.75,
    rough: 0.2,
  }),
  // 门口一小堆矿石：一眼是"厂"不是"仓库"
  sphere(0.13, PAL.stone, [-0.5, 0.31, 0.6], 1),
  sphere(0.1, PAL.crystal, [-0.68, 0.28, 0.52], 1),
];

/** 弓手营：矮棚 + 箭靶 + 一捆箭。识别符是那块圆靶。 */
export const archery: ModelSpec = [
  footing(),
  plinth([S, 0.12, S], PAL.stoneDark, [0, 0, 0]),
  // 墙抬到台基上：0.12 + 0.5/2 = 0.37，屋顶底面正好 0.62
  box([1.1, 0.5, 1.0], PAL.wallLight, [-0.22, 0.37, 0]),
  prism([1.26, 0.34, 1.16], PAL.roofRed, [-0.22, 0.62, 0]),
  // 檐下横梁：墙与檐之间给一道木构件，侧面看不至于"屋顶直接压在墙沿上"
  box([1.16, 0.07, 0.09], PAL.wood, [-0.22, 0.6, 0.48]),
  // 箭靶：两根支架 + 双层靶心，站着而不是插在地上
  cyl([0.035, 0.04, 0.52], PAL.woodDark, [0.62, 0.38, 0.1], 5),
  cyl([0.035, 0.04, 0.52], PAL.woodDark, [0.62, 0.38, -0.26], 5),
  cyl([0.28, 0.28, 0.07], PAL.snow, [0.62, 0.68, -0.08], 12),
  cyl([0.12, 0.12, 0.08], PAL.roofRed, [0.62, 0.68, -0.08], 12),
  // 干草垛 + 箭捆
  sphere(0.18, PAL.wallMid, [0.34, 0.3, 0.5], 1),
  // 三捆箭：后墙到 z=-0.50，原来最里面那捆在 -0.46，等于插在墙里
  cyl([0.05, 0.06, 0.34], PAL.wood, [0.16, 0.29, -0.66], 6),
  cyl([0.05, 0.06, 0.34], PAL.wood, [0.32, 0.29, -0.64], 6),
  cyl([0.05, 0.06, 0.34], PAL.wood, [0.24, 0.29, -0.56], 6),
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
  footing(PAL.wallDark),
  plinth([S * 0.9, 0.16, S * 0.9], PAL.snow, [0, 0, 0]),
  // 殿身：0.16 + 0.66/2 = 0.49（原来写 0.16，屋顶整个浮在墙上方 0.14，看得见缝）
  box([1.06, 0.66, 1.06], PAL.wallLight, [0, 0.49, 0]),
  // 四角立柱：跟墙同高、顶着檐口。
  // 原来放在 ±0.46，而墙到 ±0.53 —— 柱子整个埋进墙里，屏幕上根本看不见（=没画）。
  // 挪到 ±0.52，外沿 0.59 出墙 0.06，才有"四根角柱"的样子。
  cyl([0.06, 0.07, 0.66], PAL.wallMid, [-0.52, 0.49, -0.52], 6),
  cyl([0.06, 0.07, 0.66], PAL.wallMid, [0.52, 0.49, -0.52], 6),
  cyl([0.06, 0.07, 0.66], PAL.wallMid, [-0.52, 0.49, 0.52], 6),
  cyl([0.06, 0.07, 0.66], PAL.wallMid, [0.52, 0.49, 0.52], 6),
  // 锥顶（at 是中心）：底面 0.82 正好压在墙顶
  cone([0.74, 0.5], PAL.roofGold, [0, 1.07, 0], 8),
  // 门洞：下沿坐在台基顶面上（台基 0.16，门高 0.42 ⇒ 中心 0.37）
  box([0.32, 0.42, 0.06], PAL.woodDark, [0, 0.37, 0.52]),
  crystal([0.13, 0.4], PAL.glow, [0, 1.52, 0], { emissive: PAL.glow, emissiveIntensity: 0.75 }),
];

/**
 * 风车的一叶：帆杆 + 帆布 + 三道横肋，全部绕同一个轮毂转。
 *
 * 三个数决定了"它像不像风车"：杆长 1.15（桨叶半径，比 2×2 占地还宽一点）、
 * 帆布挂在杆的一侧（四叶同侧才是真风车，跨在杆上像四支十字箭）、
 * 帆布必须**又长又宽**（0.42 × 0.88）—— 上一版 0.3 × 0.76 出来是一把梯子。
 *
 * 坐标都在"轴心为原点、帆面朝 +Z"的平面里算，再由 -angle 转到这一叶朝向。
 */
function millSail(angle: number, pivot: readonly [number, number, number], spin: number): Node[] {
  const ux = Math.sin(angle);
  const uy = Math.cos(angle);
  // 帆布永远挂在前进方向的右手边：四叶同侧，转起来才是一圈扫过的帆
  const vx = Math.cos(angle);
  const vy = -Math.sin(angle);
  const spot = (along: number, perp = 0): [number, number, number] => [
    pivot[0] + ux * along + vx * perp,
    pivot[1] + uy * along + vy * perp,
    pivot[2],
  ];
  const rotZ: [number, number, number] = [0, 0, -angle];
  const live = (node: Node): Node => ({ ...node, spin, pivot, rot: rotZ });

  const out: Node[] = [
    live(box([0.055, 1.15, 0.05], PAL.woodDark, spot(0.6))),
    live(box([0.06, 0.06, 0.05], PAL.wood, spot(1.21))),
    live(box([0.42, 0.88, 0.02], PAL.canvas, spot(0.72, 0.24), { rough: 0.98, flat: false })),
  ];
  for (const along of [0.34, 0.64, 0.94]) {
    out.push(live(box([0.48, 0.03, 0.04], PAL.wood, spot(along, 0.24))));
  }
  return out;
}

/** 磨坊：收分石塔 + 木顶 + 四片帆。剪影和"会转的帆"是它的识别符，也是面包的仓。 */
export const mill: ModelSpec = [
  // 裙：2×2 的楼落在"占地内最高那块"上，最矮那格会留缝，底面必须探到 -0.10 以下
  box([0.9, 0.2, 0.9], PAL.stoneDark, [0, -0.1, 0]),
  plinth([S, 0.18, S], PAL.stoneDark, [0, 0, 0]),
  // 塔身：上窄下宽，2.5D 俯角下才有"高"的透视。
  // 颜色用 wallMid 不用 wallLight：八角面大多背光，只吃冷色轮廓光，
  // 用偏白的墙色会整根泛蓝，站在一片暖色村子里像另一套材质。
  cyl([0.42, 0.72, 1.62], PAL.wallMid, [0, 0.99, 0], 8),
  // 腰线：一圈木栈道，把塔身切成"石头在下、木头在上"
  cyl([0.68, 0.68, 0.07], PAL.woodDark, [0, 1.28, 0], 8),
  cone([0.54, 0.46], PAL.roofRed, [0, 1.8, 0], 8),
  // 轮毂从正面 (+Z) 伸出来，帆板绕着它转
  { part: { kind: 'cyl', rTop: 0.09, rBottom: 0.11, height: 0.4, seg: 8 }, color: PAL.woodDark, at: [0, 1.92, 0.4], rot: [Math.PI / 2, 0, 0] },
  ...millSail(0, [0, 1.92, 0.62], 0.5),
  ...millSail(Math.PI / 2, [0, 1.92, 0.62], 0.5),
  ...millSail(Math.PI, [0, 1.92, 0.62], 0.5),
  ...millSail((Math.PI * 3) / 2, [0, 1.92, 0.62], 0.5),
  // 门 + 门口的石磨盘 + 两袋面粉
  box([0.28, 0.6, 0.08], PAL.woodDark, [0, 0.48, 0.72]),
  cyl([0.2, 0.2, 0.06], PAL.stone, [0.66, 0.21, 0.54], 10),
  sphere(0.14, PAL.canvas, [0.56, 0.14, 0.14], 1),
  sphere(0.12, PAL.canvas, [0.7, 0.12, 0.26], 1),
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

/**
 * 箭塔：细高石塔 + 塔顶平台 + 围堞 + 锥顶。1x1 占地，整体往上收。
 *
 * 上一版塔身只有 1.4 高，而且"平台（0.9）"和"四个垛口（1.08）"全写在塔身里面 ——
 * 等于没有：塔是一根光溜溜的柱子顶着个锥子，高度还跟炮塔差不多，远看分不出来。
 * 现在塔身 1.5 高、平台在塔顶 1.62、垛口压在平台上一圈，高度拉到 2.34。
 */
export const arrowTower: ModelSpec = [
  plinth([0.86, 0.12, 0.86], PAL.stoneDark, [0, 0, 0]),
  cyl([0.3, 0.4, 1.5], PAL.stone, [0, 0.87, 0], 8),
  // 塔顶平台：底面正压在塔身顶（1.62）上
  box([0.76, 0.1, 0.76], PAL.wallLight, [0, 1.67, 0]),
  // 四角垛口：站在平台上，不再埋进塔身
  box([0.14, 0.2, 0.14], PAL.wallDark, [0.29, 1.82, 0.29]),
  box([0.14, 0.2, 0.14], PAL.wallDark, [-0.29, 1.82, 0.29]),
  box([0.14, 0.2, 0.14], PAL.wallDark, [0.29, 1.82, -0.29]),
  box([0.14, 0.2, 0.14], PAL.wallDark, [-0.29, 1.82, -0.29]),
  // 两道箭窗：贴在塔身外皮上（往里缩半个厚度就会看不见）
  box([0.08, 0.26, 0.06], PAL.wallDark, [0, 0.9, 0.36]),
  box([0.08, 0.26, 0.06], PAL.wallDark, [0, 1.25, -0.36]),
  cone([0.4, 0.42], PAL.roofRed, [0, 2.13, 0], 6),
];

/**
 * 炮塔：矮胖石堡 + **塔顶炮台转台** + 一门朝外的主炮。
 *
 * 上一版是从箭塔复制过来的：石堡四面上各插一根炮管，"炮长在身上"，
 * 而且总高跟箭塔差不多，两个塔在屏幕上是同一个剪影。
 * 现在炮塔压矮加宽（总高 1.5，箭塔 2.34），炮架在堡顶的八棱转台上 —— 一眼就是"炮"。
 */
const CANNON_PIVOT: [number, number, number] = [0, 1.22, 0];

export const cannonTower: ModelSpec = [
  plinth([0.94, 0.18, 0.94], PAL.stoneDark, [0, 0, 0]),
  // 堡身：0.18 → 0.98，比箭塔矮、比箭塔宽
  box([0.8, 0.8, 0.8], PAL.stone, [0, 0.58, 0]),
  // 压顶檐口：比堡身宽出一圈，炮台就坐在这个"肩膀"上
  box([0.96, 0.16, 0.96], PAL.stoneDark, [0, 1.06, 0]),
  // ↓ 以下四件是**可转炮台**（turret = 转轴，取炮盘中心）。
  // 炮管朝 +Z ⇒ 瞄准 yaw = atan2(dx, dz)，视图每帧朝最近敌人转过去。
  // 炮台木盘
  { part: { kind: 'cyl', rTop: 0.32, rBottom: 0.36, height: 0.16, seg: 8 }, color: PAL.wallMid, at: [0, 1.22, 0], turret: CANNON_PIVOT },
  // 炮车：托着炮管的那块木头
  { part: { kind: 'box', size: [0.3, 0.16, 0.52] }, color: PAL.woodDark, at: [0, 1.34, -0.02], turret: CANNON_PIVOT },
  // 主炮：粗、深铁色，炮口朝 +Z（默认机位那一面），炮口一道亮箍
  { part: { kind: 'cyl', rTop: 0.15, rBottom: 0.17, height: 0.78, seg: 8 }, color: PAL.iron, at: [0, 1.46, 0.3], rot: [Math.PI / 2 - 0.1, 0, 0], turret: CANNON_PIVOT },
  { part: { kind: 'cyl', rTop: 0.2, rBottom: 0.2, height: 0.1, seg: 8 }, color: PAL.metal, at: [0, 1.5, 0.64], rot: [Math.PI / 2 - 0.1, 0, 0], turret: CANNON_PIVOT },
  // 檐口上的弹药箱 + 堡前三颗铁弹（跟着堡身走，不转）
  box([0.24, 0.18, 0.2], PAL.woodDark, [0.3, 1.23, -0.34]),
  sphere(0.11, PAL.iron, [0.3, 0.29, 0.34], 1),
  sphere(0.1, PAL.iron, [0.44, 0.28, 0.18], 1),
  sphere(0.09, PAL.iron, [0.2, 0.27, 0.46], 1),
];

/** 魔法塔：细高石塔 + 顶端悬浮晶核，夜里靠它当地标。 */
export const magicTower: ModelSpec = [
  plinth([0.84, 0.14, 0.84], PAL.stoneDark, [0, 0, 0]),
  // 下段塔身：0.14 → 1.06
  cyl([0.36, 0.42, 0.92], PAL.wallLight, [0, 0.6, 0], 8),
  // 符带（套在下段塔身上，比塔身粗一圈）
  cyl([0.43, 0.43, 0.06], PAL.crystal, [0, 0.8, 0], 8),
  // 悬空段的底盘：一圈石环，四根柱子从这儿起
  cyl([0.42, 0.42, 0.08], PAL.stoneDark, [0, 1.1, 0], 8),
  // 四根细柱撑起上段 —— 中间是掏空的，不是实心塔身
  cyl([0.045, 0.05, 0.78], PAL.wallLight, [0.24, 1.53, 0.24], 6),
  cyl([0.045, 0.05, 0.78], PAL.wallLight, [-0.24, 1.53, 0.24], 6),
  cyl([0.045, 0.05, 0.78], PAL.wallLight, [0.24, 1.53, -0.24], 6),
  cyl([0.045, 0.05, 0.78], PAL.wallLight, [-0.24, 1.53, -0.24], 6),
  // 悬在空腔正中的晶核：**故意不接触任何件**（float 标记），还绕自己慢慢转
  {
    ...crystal([0.22, 0.6], 0x5fd8ff, [0, 1.53, 0], { emissive: 0x5fd8ff, emissiveIntensity: 1.25, rough: 0.15 }),
    float: true,
    spin: 0.4,
    pivot: [0, 1.52, 0],
  },
  // 上段：檐口 → 小塔身 → 蓝顶（顶要压在小塔身上，别悬着）
  cyl([0.42, 0.42, 0.08], PAL.stoneDark, [0, 1.96, 0], 8),
  cyl([0.3, 0.36, 0.34], PAL.wallLight, [0, 2.17, 0], 8),
  cone([0.44, 0.54], PAL.roofBlue, [0, 2.61, 0], 8),
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
