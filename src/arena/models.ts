/**
 * 对战模式的建筑模型 —— **纯数据**（不 import three、不 import 任何东西）。
 *
 * 每栋楼分成两层：
 * - `static`：不会掉的件（台基、屋顶、门、**内部骨架**）—— 交给套件的 `buildModel`；
 * - `shell`：外墙/塔身的**面片**（一块块 0.3 格左右的板）—— 视图侧合成一张网格，
 *   受伤时整块脱落（见 `shell.ts`），露出里面的骨架。
 *
 * 这样"碎裂"不是贴一张破洞贴纸，而是外壳真的少了一块：洞的形状就是面片的轮廓，
 * 掉下去的块也真的是原来那块板。
 *
 * 坐标约定与 `game/models/kit.ts` 完全一致（不是另起一套）：
 * - box / cyl / cone / sphere / crystal 的 `at` 是**中心**；
 * - prism / plinth 的 `at` 是**底面**。
 * 所以纵向位置一律用 `mid(底, 高)` 写，别手算中心点。
 *
 * 单位是**模型单位**，进游戏时整组乘 `BUILDING_SCALE`（2.2）。注释里的"格"都是乘完的值。
 * 设计语言：3×3 占地、每栋一个唯一剪影、阵营色只落在小面积、骨架只从破洞里露出来。
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
  /**
   * 上半椭球（"扣在地上的碗"）：底面半径 `radius`、总高 `height`。
   * **锚点在底面中心**（和 prism / plinth 一样），不是球心 —— 地堡要"贴地长出来"，
   * 拿球心当锚点每次都得手算球心，是错位的来源。
   */
  | { kind: 'dome'; radius: number; height: number; seg?: number }
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

/** 一块可脱落的外墙面片（模型局部坐标）。 */
export interface ShellPanel {
  /** 面板中心 */
  x: number;
  y: number;
  z: number;
  /** 宽、高、厚 */
  w: number;
  h: number;
  t: number;
  /** 绕 y 的转角：外法线 = (sin yaw, 0, cos yaw) */
  yaw: number;
  color: number;
}

/** 一栋楼的完整说明书：不动的件 + 可脱落的墙面片。 */
export interface ArenaModel {
  static: Node[];
  shell: ShellPanel[];
}

// ---------------------------------------------------------------- 阵营配色

/** 明度缩放：k<1 压暗、k>1 提亮。纯算术，不 import three。 */
export function shade(color: number, k: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * k));
  const b = Math.min(255, Math.round((color & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** 两色按比例混。k=0 全是 a、k=1 全是 b。 */
export function mix(a: number, b: number, k: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/**
 * **屋顶瓦 = 阵营色压暗**（蓝方深蓝瓦、红方深红瓦）。
 *
 * 用户 2026-10-27：「我方和敌方房顶的颜色……是不一样的」。
 * 上一版只有磨坊顶盖吃阵营色，其余五栋的屋顶全是同一个红棕 `ARENA_PAL.roof`，
 * 隔着一个战场根本分不出哪栋是谁的（实测双方颜色集合只差旗子和血条）。
 * 不用"红棕混阵营色"是因为红棕本身含大量红，混蓝会发紫 —— 直接把阵营色压暗更干净。
 */
export const roofOf = (accent: number): number => shade(accent, 0.68);
/** 屋脊/檐口：比瓦再暗一档，屋顶才有层次，不至于是一坨纯色。 */
export const ridgeOf = (accent: number): number => shade(accent, 0.46);
/** 帆布这类"布"的件：米色往阵营偏，布还是布，但两边不同色。 */
export const clothOf = (accent: number): number => mix(0xe6d8b4, accent, 0.52);

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
  /** 屋里的暗色：破洞后面的"深度" */
  inside: 0x35281e,
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

/** 上半椭球：`at` 是**底面中心**（和 prism / plinth 一致）。兽人巢穴的穹顶用它。 */
const dome = (radius: number, height: number, color: number, at: Vec3 = [0, 0, 0], seg = 12): Node => ({
  part: { kind: 'dome', radius, height, seg },
  color,
  at,
});

const crystal = (radius: number, height: number, color: number, at: Vec3 = [0, 0, 0]): Node => ({
  part: { kind: 'crystal', radius, height },
  color,
  at,
  paint: { emissive: color, emissiveIntensity: 0.9, rough: 0.25 },
});

// ---------------------------------------------------------------- 面片生成

/** 面片厚度（模型单位）：0.06 × 2.2 ≈ 0.13 格，掉下来看得见厚度 */
const PANEL_T = 0.06;

/** 很小的确定性随机：只用来做"每块砖差一点颜色"和切分，不参与玩法 */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 同色微差：一块块砌上去的感觉，但整体还是一个色族 */
function toneShift(color: number, k: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * k));
  const b = Math.min(255, Math.round((color & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/**
 * 方墙四面切面片：前后两面铺满宽，左右两面缩进一个板厚（角上不重叠，免得闪面）。
 * `cols` 是每面的列数，`rows` 是行数；面板外皮正好落在 ±w/2 / ±d/2（和原来的实心墙同轮廓）。
 */
function boxShell(
  w: number,
  d: number,
  y0: number,
  h: number,
  color: number,
  cols: number,
  rows: number,
  seed: number,
): ShellPanel[] {
  const rnd = lcg(seed);
  const out: ShellPanel[] = [];
  const pw = w / cols;
  const pd = (d - PANEL_T * 2) / cols;
  const ph = h / rows;
  const shade = () => toneShift(color, 0.92 + rnd() * 0.14);
  for (let row = 0; row < rows; row++) {
    const y = y0 + (row + 0.5) * ph;
    for (let i = 0; i < cols; i++) {
      const off = -w / 2 + (i + 0.5) * pw;
      const offD = -(d - PANEL_T * 2) / 2 + (i + 0.5) * pd;
      out.push({ x: off, y, z: d / 2 - PANEL_T / 2, w: pw, h: ph, t: PANEL_T, yaw: 0, color: shade() });
      out.push({ x: off, y, z: -(d / 2 - PANEL_T / 2), w: pw, h: ph, t: PANEL_T, yaw: Math.PI, color: shade() });
      out.push({ x: w / 2 - PANEL_T / 2, y, z: offD, w: pd, h: ph, t: PANEL_T, yaw: Math.PI / 2, color: shade() });
      out.push({ x: -(w / 2 - PANEL_T / 2), y, z: offD, w: pd, h: ph, t: PANEL_T, yaw: -Math.PI / 2, color: shade() });
    }
  }
  return out;
}

/**
 * 圆塔切面片：一圈 `segs` 条 × `rows` 行，板宽取弦长（略放大 3% 盖住缝）。
 * 半径按行中点插值，所以收分的塔身也能贴合。
 */
function ringShell(
  rBottom: number,
  rTop: number,
  y0: number,
  h: number,
  color: number,
  segs: number,
  rows: number,
  seed: number,
): ShellPanel[] {
  const rnd = lcg(seed);
  const out: ShellPanel[] = [];
  const ph = h / rows;
  for (let row = 0; row < rows; row++) {
    const k = (row + 0.5) / rows;
    const r = rBottom + (rTop - rBottom) * k;
    const y = y0 + (row + 0.5) * ph;
    const w = 2 * r * Math.sin(Math.PI / segs) * 1.03;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      out.push({
        x: Math.cos(a) * (r - PANEL_T / 2),
        y,
        z: Math.sin(a) * (r - PANEL_T / 2),
        w,
        h: ph,
        t: PANEL_T,
        yaw: Math.PI / 2 - a,
        color: toneShift(color, 0.92 + rnd() * 0.14),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 五栋楼

/**
 * 大本营：石台 + 石裙 + **方墙（面片）** + 四角柱 + 四坡顶 + 水晶。
 * 墙里有木骨架 + 暗色内衬：墙片掉了能看见梁柱。
 *
 * 模型本身沿用老模式那栋"议事厅"的骨架 —— 两个模式共用同一套建模语言，
 * 但玩法上它是**大本营**（用户 2026-11-01 纠正的术语），别再叫"核心"。
 */
export function coreModel(accent: number): ArenaModel {
  return {
    static: [
      plinth([1.8, 0.07, 1.8], ARENA_PAL.stoneDark),
      box([1.7, 0.5, 1.7], ARENA_PAL.stone, [0, mid(0.07, 0.5), 0]),
      // 门开在石座上，门前一级石阶
      box([0.34, 0.42, 0.07], ARENA_PAL.wood, [0, mid(0.07, 0.42), 0.86]),
      box([0.44, 0.06, 0.08], ARENA_PAL.gold, [0, 0.54, 0.87]),
      box([0.5, 0.12, 0.18], ARENA_PAL.stone, [0, mid(0.07, 0.12), 0.97]),
      // 四角石柱：墙片掉光之后仍然是四根角柱撑着屋顶
      cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [-0.66, mid(0.57, 1.05), -0.66], 6),
      cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [0.66, mid(0.57, 1.05), -0.66], 6),
      cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [-0.66, mid(0.57, 1.05), 0.66], 6),
      cyl([0.07, 0.08, 1.05], ARENA_PAL.stone, [0.66, mid(0.57, 1.05), 0.66], 6),
      box([1.4, 0.09, 1.4], ARENA_PAL.wallDark, [0, mid(1.57, 0.09), 0]),
      box([1.74, 0.06, 1.74], ARENA_PAL.roofDark, [0, mid(1.66, 0.06), 0]),
      {
        part: { kind: 'cone', radius: 1.22, height: 0.66, seg: 4 },
        color: roofOf(accent),
        at: [0, mid(1.72, 0.66), 0],
        rot: [0, Math.PI / 4, 0],
      },
      // 四条屋脊压在四坡顶的棱上：阵营色，从高处也能一眼看出是谁的主城
      box([0.1, 0.08, 1.76], ridgeOf(accent), [-0.84, 1.94, 0]),
      box([0.1, 0.08, 1.76], ridgeOf(accent), [0.84, 1.94, 0]),
      box([1.76, 0.08, 0.1], ridgeOf(accent), [0, 1.94, -0.84]),
      box([1.76, 0.08, 0.1], ridgeOf(accent), [0, 1.94, 0.84]),
      crystal(0.2, 0.62, accent, [0, mid(2.28, 0.62), 0]),
      // 屋内：暗色内衬（洞的"深度"）+ 木骨架。
      // 骨架只留前后两根肋（原来四根）：机型锁要求固定件 ≤22，而屋顶那 4 条阵营色屋脊
      // 更值得占这个名额 —— 屋脊是**随时**看得见的敌我标记，肋只有墙被打穿才露出来。
      box([1.06, 1.0, 1.06], ARENA_PAL.inside, [0, mid(0.57, 1.0), 0]),
      cyl([0.035, 0.04, 1.0], ARENA_PAL.wood, [-0.52, mid(0.57, 1.0), -0.52], 5),
      cyl([0.035, 0.04, 1.0], ARENA_PAL.wood, [0.52, mid(0.57, 1.0), 0.52], 5),
      box([1.12, 0.07, 0.07], ARENA_PAL.woodLight, [0, 1.1, 0.52]),
      box([1.12, 0.07, 0.07], ARENA_PAL.woodLight, [0, 1.44, -0.52]),
    ],
    shell: boxShell(1.42, 1.42, 0.57, 1.0, ARENA_PAL.wall, 4, 3, 11),
  };
}

/**
 * 兵营（P-095 改型）：**平顶 + 墙垛**的方形营堡。
 *
 * 用户 2026-11-10："很多建筑重复性太高了，比如说那个兵营，
 * 我希望变成一个平顶的，有墙垛。"
 * 旧版是「长屋 + 双坡脊」，和民居 / 商行全是人字顶，隔着战场根本分不出谁是谁。
 * 现在双坡顶换成平屋面 + 一圈女儿墙 + 8 座城垛：兵营从此是**方形堡垒**，
 * 民居 / 商行仍是坡顶小屋，剪影一眼分家。
 *
 * 件数仍压在 22 件以内（`tests/models.test.ts` 的体型锁）：
 * 去掉旧屋顶 3 件（prism + 屋脊 + 檐口）、去掉兵器架顶上那块小铁，
 * 换来平屋面 1 + 女儿墙 1 + 城垛 8 = 10 件。
 */
export function barracksModel(accent: number): ArenaModel {
  const WALL_TOP = 0.84;
  const MERLON_H = 0.17;
  const MERLON_Y = WALL_TOP + 0.17 + MERLON_H / 2;
  // 城垛是米石带一点阵营色：蓝方偏冷、红方偏暖，远看仍能分敌我，
  // 又不会像纯 roofOf 那样在预览里糊成一整块黑板。
  const merlonColor = mix(ARENA_PAL.wall, accent, 0.3);
  const merlons: Node[] = [
    // 正面（朝镜头）四座
    ...[-0.63, -0.21, 0.21, 0.63].map((x) =>
      box([0.24, MERLON_H, 0.16], merlonColor, [x, MERLON_Y, 0.52])),
    // 左右两侧各两座：转个方向，别看起来只贴了一面板子
    ...[-1, 1].flatMap((s) => [-0.28, 0.28].map((z) =>
      box([0.16, MERLON_H, 0.24], merlonColor, [s * 0.74, MERLON_Y, z]))),
  ];
  return {
    static: [
      plinth([1.5, 0.06, 1.16], ARENA_PAL.stoneDark),
      box([1.45, 0.16, 1.02], ARENA_PAL.stoneDark, [0, mid(0.06, 0.16), 0]),
      // 平屋面：替代原来的双坡 prism，顶面就是垛口的落脚地
      box([1.6, 0.12, 1.12], roofOf(accent), [0, WALL_TOP + 0.06, 0]),
      // 女儿墙压顶用**灰石平台**而不是深瓦：平顶从上方看是一整片，
      // 若沿用 ridgeOf 会黑成一整块黑板（离线预览里量过），城垛就成了"黑板上摆牙"。
      box([1.66, 0.1, 1.18], ARENA_PAL.stone, [0, WALL_TOP + 0.16, 0]),
      ...merlons,
      box([0.34, 0.46, 0.06], ARENA_PAL.wood, [0, mid(0.22, 0.46), 0.52]),
      box([0.44, 0.05, 0.07], ARENA_PAL.woodLight, [0, 0.7, 0.52]),
      cyl([0.035, 0.04, 0.6], ARENA_PAL.wood, [-0.62, mid(0.22, 0.6), 0.46], 5),
      cyl([0.035, 0.04, 0.6], ARENA_PAL.wood, [0.62, mid(0.22, 0.6), 0.46], 5),
      cyl([0.022, 0.026, 0.9], ARENA_PAL.woodLight, [0.55, mid(0.06, 0.9), 0.62], 5),
      cyl([0.022, 0.026, 0.9], ARENA_PAL.woodLight, [0.64, mid(0.06, 0.9), 0.64], 5),
      // 屋内：内衬 + 两根柱 + 一根横梁（P-095 添了 8 座城垛，柱从三根收成两根，件数仍 ≤22）
      box([1.2, 0.62, 0.74], ARENA_PAL.inside, [0, mid(0.22, 0.62), 0]),
      cyl([0.03, 0.035, 0.62], ARENA_PAL.wood, [-0.44, mid(0.22, 0.62), 0.26], 5),
      cyl([0.03, 0.035, 0.62], ARENA_PAL.wood, [0.44, mid(0.22, 0.62), 0.26], 5),
      box([1.2, 0.06, 0.06], ARENA_PAL.woodLight, [0, 0.7, 0.26]),
    ],
    shell: boxShell(1.42, 0.98, 0.22, 0.62, ARENA_PAL.wall, 4, 2, 23),
  };
}

/**
 * 箭塔：细高石鼓 + 外挑垛口 + 三面箭窗 + 锥顶。
 * 鼓身是面片，掉了露出暗色内筒、四根木肋和两层木楼板。
 */
export function arrowTowerModel(accent: number): ArenaModel {
  return {
    static: [
      plinth([1.12, 0.06, 1.12], ARENA_PAL.stoneDark),
      cyl([0.5, 0.6, 0.5], ARENA_PAL.stone, [0, mid(0.06, 0.5), 0], 10),
      cyl([0.58, 0.58, 0.07], ARENA_PAL.stoneDark, [0, mid(1.61, 0.07), 0], 10),
      // 外挑的垛口台保留；用户 2026-10-27 点名去掉上面那 4 个正方形齿
      cyl([0.68, 0.55, 0.22], ARENA_PAL.stone, [0, mid(1.68, 0.22), 0], 10),
      box([0.09, 0.3, 0.05], ARENA_PAL.stoneDark, [0, mid(1.0, 0.3), 0.545]),
      box([0.05, 0.3, 0.09], ARENA_PAL.stoneDark, [0.545, mid(1.0, 0.3), 0]),
      box([0.05, 0.3, 0.09], ARENA_PAL.stoneDark, [-0.545, mid(1.0, 0.3), 0]),
      cone(0.5, 0.8, roofOf(accent), [0, mid(1.9, 0.8), 0], 8),
      // 顶珠换阵营色（原来是金色的）：塔顶那一小点是最容易被看见的敌我标记
      sphere(0.07, accent, [0, 2.74, 0], 1),
      // 垛口台上一圈阵营色压顶
      cyl([0.6, 0.6, 0.05], ridgeOf(accent), [0, mid(1.86, 0.05), 0], 10),
      // 屋内：暗色内筒 + 四根木肋 + 两层木楼板
      cyl([0.42, 0.42, 1.05], ARENA_PAL.inside, [0, mid(0.56, 1.05), 0], 10),
      cyl([0.035, 0.04, 1.05], ARENA_PAL.wood, [0.47, mid(0.56, 1.05), 0], 5),
      cyl([0.035, 0.04, 1.05], ARENA_PAL.wood, [-0.47, mid(0.56, 1.05), 0], 5),
      cyl([0.035, 0.04, 1.05], ARENA_PAL.wood, [0, mid(0.56, 1.05), 0.47], 5),
      cyl([0.035, 0.04, 1.05], ARENA_PAL.wood, [0, mid(0.56, 1.05), -0.47], 5),
      cyl([0.5, 0.5, 0.05], ARENA_PAL.woodLight, [0, mid(0.72, 0.05), 0], 10),
      cyl([0.48, 0.48, 0.05], ARENA_PAL.woodLight, [0, mid(1.46, 0.05), 0], 10),
    ],
    shell: ringShell(0.56, 0.52, 0.56, 1.05, ARENA_PAL.wall, 10, 3, 37),
  };
}

/**
 * 炮塔：方座 + 木台 + 四角防撞块 + 转台炮管。
 * 上层的石座是面片，掉了露出暗色内衬和四根木柱。
 */
export function cannonTowerModel(accent: number): ArenaModel {
  const PIVOT: Vec3 = [0, 0.86, 0];
  const bumper = (x: number, z: number): Node =>
    box([0.22, 0.22, 0.22], accent, [x, mid(0.86, 0.22), z], {
      emissive: accent,
      emissiveIntensity: 0.3,
      rough: 0.55,
    });
  return {
    static: [
      plinth([1.42, 0.06, 1.42], ARENA_PAL.stoneDark),
      box([1.32, 0.36, 1.32], ARENA_PAL.stoneDark, [0, mid(0.06, 0.36), 0]),
      cyl([0.58, 0.62, 0.1], ARENA_PAL.wood, [0, mid(0.76, 0.1), 0], 10),
      // 台面下沿一圈阵营色带：炮塔是敞开的没有屋顶，这条带就是它的"房顶色"
      cyl([0.66, 0.66, 0.05], ridgeOf(accent), [0, mid(0.64, 0.05), 0], 10),
      bumper(-0.46, -0.46),
      bumper(0.46, -0.46),
      bumper(-0.46, 0.46),
      bumper(0.46, 0.46),
      { ...cyl([0.3, 0.34, 0.16], ARENA_PAL.iron, [0, mid(0.86, 0.16), 0], 8), turret: PIVOT },
      { ...box([0.44, 0.28, 0.44], ARENA_PAL.iron, [0, mid(1.02, 0.28), 0]), turret: PIVOT },
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
      box([0.2, 0.16, 0.18], ARENA_PAL.wood, [0.44, mid(0.86, 0.16), -0.44]),
      // 屋内：暗色内衬 + 四根木柱 + 一圈横梁
      box([1.0, 0.34, 1.0], ARENA_PAL.inside, [0, mid(0.42, 0.34), 0]),
      cyl([0.03, 0.035, 0.34], ARENA_PAL.wood, [-0.4, mid(0.42, 0.34), -0.4], 5),
      cyl([0.03, 0.035, 0.34], ARENA_PAL.wood, [0.4, mid(0.42, 0.34), -0.4], 5),
      cyl([0.03, 0.035, 0.34], ARENA_PAL.wood, [-0.4, mid(0.42, 0.34), 0.4], 5),
      cyl([0.03, 0.035, 0.34], ARENA_PAL.wood, [0.4, mid(0.42, 0.34), 0.4], 5),
      box([1.02, 0.05, 0.05], ARENA_PAL.woodLight, [0, 0.7, 0.4]),
    ],
    shell: boxShell(1.2, 1.2, 0.42, 0.34, ARENA_PAL.stone, 3, 1, 53),
  };
}

/**
 * 磨坊（2026-10-27 重绘，用户：小磨坊太丑了）。
 *
 * 上一版丑在三处，都是量得出来的：
 * 1. **帆太小**：帆直径 1.2、塔高 2.28 ⇒ 只有塔高的 52%，远看是"塔顶贴了四片纸"，
 *    读不出这是风车。真风车的帆直径接近塔高。
 * 2. **帆不像帆**：两根交叉细杆上挂四块 0.24×0.56 的**独立小方布**，块与块之间不连，
 *    转起来像四片贴纸在飘，没有"一片帆"的形状。
 * 3. **没有收分的层次**：塔身虽然是圆锥，但檐盘（r 0.64）比塔顶（r 0.46）宽一大截，
 *    再扣一个 0.58 半径的尖帽 —— 从上往下看就是"一根管子上顶了个大斗笠"。
 *
 * 这一版：
 * - 塔身收分更明显（下 0.66 → 上 0.42），**腰部加一圈挑出的木栈道**（风车的标志）；
 * - 顶盖改成**阵营色瓦**并压低（0.66 高、0.5 半径），不再头重；
 * - 帆重做：一个中心毂 + 两根交叉长梁（直径 **1.7 ≈ 塔高的 75%**）+
 *   四片**顺着梁的长条布**（0.32×0.78，布和梁同向，看着才是一片帆），布按阵营上色。
 */
export function millModel(accent: number): ArenaModel {
  const PIVOT: Vec3 = [0, 1.62, 0.76];
  const sail = (node: Node): Node => ({ ...node, spin: 1.7, pivot: PIVOT });
  const ARM = 0.85; // 帆的半長：直径 1.7
  /**
   * 布心离轴心的距离，与布所在的 z。
   *
   * 上一版（用户 2026-10-28："帆错位了，应该紧紧贴着那个木棍，就在木棍后面"）：
   * 布的位置是手算的散点，比如 `[0.2, 2.02]` —— 相对轴心 (0,1.62) 的方向是 **63°**，
   * 而梁长轴是 **45°**。**布和梁不同向**，看上去就是帆飘在棍子旁边，没贴在棍子上。
   *
   * 这一版按梁的方向线摆：绕 z 转 θ 的竖直长条，长轴方向是 90°+θ，
   * 所以布的中心也必须在同一条方向线上（±cos45 分解），布自身的 rot 与梁同值。
   * - `ALONG`：布长 0.78 ⇒ 覆盖 0.08~0.86，正好铺满 0.85 的臂；
   * - `CLOTH_Z`：帆布绷在木梁的**前面**（镜头在 +z 那侧）—— 梁厚 0.05、中心 0.76（占 0.735~0.785），
   *   布厚 0.03 ⇒ 布的后表面落在 0.785，正好抵住梁的正面。
   *   （2026-10-28 用户先要"贴在木棍后面"，看过之后改成**前面**：布在外、木梁当骨架露在布后，
   *   才是风车该有的读法 —— 反过来会像帆被棍子压住。）
   */
  const ALONG = 0.47 * Math.SQRT1_2; // 0.332 = 0.47 × cos45
  const CLOTH_Z = 0.8;
  return {
    static: [
      plinth([1.16, 0.07, 1.16], ARENA_PAL.stoneDark),
      // 腰部木栈道：挑出塔身一圈，风车的标志件
      cyl([0.72, 0.72, 0.05], ARENA_PAL.wood, [0, mid(0.6, 0.05), 0], 12),
      // 门 + 门楣 + 一扇小窗
      box([0.3, 0.48, 0.07], ARENA_PAL.wood, [0, mid(0.07, 0.48), 0.62]),
      box([0.42, 0.06, 0.08], ARENA_PAL.woodLight, [0, 0.6, 0.63]),
      box([0.16, 0.18, 0.05], ARENA_PAL.stoneDark, [-0.4, 1.16, 0.52]),
      // 檐盘（比塔顶宽一点就够，别再做成斗笠）
      cyl([0.52, 0.52, 0.06], ARENA_PAL.roofDark, [0, mid(1.62, 0.06), 0], 12),
      { ...cone(0.5, 0.66, roofOf(accent), [0, mid(1.68, 0.66), 0], 12), paint: { rough: 0.85 } },
      sphere(0.07, accent, [0, 2.4, 0], 1),
      // 帆毂：转轴根上那块铁盘
      {
        part: { kind: 'cyl', rTop: 0.11, rBottom: 0.12, height: 0.16, seg: 8 },
        color: ARENA_PAL.iron,
        at: [0, 1.62, 0.66],
        rot: [Math.PI / 2, 0, 0],
      },
      // 两根交叉长梁 ⇒ 四个臂
      sail({ ...box([0.075, ARM * 2, 0.05], ARENA_PAL.wood, [0, 1.62, 0.76]), rot: [0, 0, Math.PI / 4] }),
      sail({ ...box([0.075, ARM * 2, 0.05], ARENA_PAL.wood, [0, 1.62, 0.76]), rot: [0, 0, -Math.PI / 4] }),
      // 四片帆布：沿梁的方向铺在四个臂上，紧贴木梁的**正面**（布在外、梁当骨架）
      sail({ ...box([0.32, 0.78, 0.03], clothOf(accent), [-ALONG, 1.62 + ALONG, CLOTH_Z]), rot: [0, 0, Math.PI / 4] }),
      sail({ ...box([0.32, 0.78, 0.03], clothOf(accent), [ALONG, 1.62 - ALONG, CLOTH_Z]), rot: [0, 0, Math.PI / 4] }),
      sail({ ...box([0.32, 0.78, 0.03], clothOf(accent), [ALONG, 1.62 + ALONG, CLOTH_Z]), rot: [0, 0, -Math.PI / 4] }),
      sail({ ...box([0.32, 0.78, 0.03], clothOf(accent), [-ALONG, 1.62 - ALONG, CLOTH_Z]), rot: [0, 0, -Math.PI / 4] }),
      // 屋内：暗色内筒 + 四根木肋 + 两层楼板
      cyl([0.38, 0.38, 1.55], ARENA_PAL.inside, [0, mid(0.07, 1.55), 0], 10),
      cyl([0.035, 0.04, 1.55], ARENA_PAL.wood, [0.44, mid(0.07, 1.55), 0], 5),
      cyl([0.035, 0.04, 1.55], ARENA_PAL.wood, [-0.44, mid(0.07, 1.55), 0], 5),
      cyl([0.035, 0.04, 1.55], ARENA_PAL.wood, [0, mid(0.07, 1.55), 0.44], 5),
      cyl([0.52, 0.52, 0.05], ARENA_PAL.woodLight, [0, mid(0.62, 0.05), 0], 10),
      cyl([0.44, 0.44, 0.05], ARENA_PAL.woodLight, [0, mid(1.24, 0.05), 0], 10),
    ],
    shell: ringShell(0.66, 0.42, 0.07, 1.55, ARENA_PAL.wall, 10, 4, 67),
  };
}

/**
 * 民居：小一号的方屋 + 双坡顶 + 烟囱 + 一扇窗。
 * 剪影：**比兵营矮、比兵营方**，屋顶多一根烟囱。不出兵也不产金，给兵营当后勤。
 */
export function houseModel(accent: number): ArenaModel {
  return {
    static: [
      plinth([1.2, 0.06, 1.02], ARENA_PAL.stoneDark),
      box([0.28, 0.42, 0.06], ARENA_PAL.wood, [0, mid(0.06, 0.42), 0.46]),
      box([0.36, 0.05, 0.07], ARENA_PAL.woodLight, [0, 0.5, 0.46]),
      box([0.22, 0.2, 0.05], ARENA_PAL.stoneDark, [-0.32, 0.38, 0.45]),
      prism([1.3, 0.44, 1.04], roofOf(accent), [0, 0.72, 0]),
      box([1.32, 0.06, 0.11], ridgeOf(accent), [0, mid(1.14, 0.06), 0]),
      box([1.32, 0.05, 0.09], ARENA_PAL.roofDark, [0, mid(1.14, 0.05), 0]),
      // 烟囱：和兵营区分开的那一根；烟囱帽用阵营色
      box([0.16, 0.55, 0.16], ARENA_PAL.stone, [-0.38, mid(0.78, 0.55), -0.28]),
      box([0.2, 0.05, 0.2], ridgeOf(accent), [-0.38, mid(1.33, 0.05), -0.28]),
      // 屋内：内衬 + 两根柱 + 一根横梁
      box([0.94, 0.66, 0.68], ARENA_PAL.inside, [0, mid(0.06, 0.66), 0]),
      cyl([0.03, 0.035, 0.66], ARENA_PAL.wood, [-0.3, mid(0.06, 0.66), 0.24], 5),
      cyl([0.03, 0.035, 0.66], ARENA_PAL.wood, [0.3, mid(0.06, 0.66), 0.24], 5),
      box([0.96, 0.05, 0.05], ARENA_PAL.woodLight, [0, 0.66, 0.24]),
    ],
    shell: boxShell(1.14, 0.88, 0.06, 0.66, ARENA_PAL.wall, 3, 2, 83),
  };
}


/**
 * **齿轮工厂**（2026-11-07 设计文档 C 节）：第一栋 4×3 建筑，解锁三架飞行器。
 *
 * 复古厂房：石台 + 砖墙 + 木梁 + 双坡顶 + **两根烟囱**；前墙贴着一枚大齿轮
 * （圆盘 12 齿 4 辐条）和一枚反向咬合的小齿轮，两轮一直转。
 *
 * ## 2026-11-07 返工：穿模 / 太高 / 烟囱只有一根
 *
 * 用户上机原话："工业工厂穿模了，其次要求它没那么高，可以稍微矮一点，有两个烟囱，有齿轮转"。
 * 量出来的三处硬伤（视图把模型整体乘 `BUILDING_SCALE=2.2`，工厂当时还额外乘 1.18 = **2.596**）：
 *  1. 台基宽 2.3 × 2.596 = **5.97 格**，而占地只有 4 格 —— 屋顶/台基必然盖到隔壁格子上；
 *  2. 齿轮中心 z=0.95 × 2.596 = **2.47 格**（占地半深才 1.5 格），整个轮子悬在墙外、
 *     下缘还插进台基；齿轮 y 上半和屋顶也有交叠；
 *  3. 总高 2.72 × 2.596 = **7.06 格**，比大本营还高；而旗位 `base=2.25 格` 远低于屋顶，
 *     旗杆整根从砖墙里长出来。施工外壳 `y0=0.06` 也和砖墙 `0.48~1.63` 完全错位。
 *
 * 现在所有尺寸按**占地倒推**（模型单位 = 格 / 2.2）：
 *  x 半宽 ≤ 4/2/2.2 = 0.909，z 半深 ≤ 3/2/2.2 = 0.682，实测取 0.86 / 0.60，
 *  含齿轮最远 z=0.60 → 1.32 格，仍留在 1.5 格内。总高 1.59 × 2.2 = 3.50 格
 *  （P-095 钝角缓坡顶后从 1.87 / 4.11 格压下来的）。
 *  额外那道 1.18 缩放已在 ArenaApp 里删掉（真楼和拖放影子两处），全楼统一 2.2。
 *
 * 齿轮复用磨坊帆的 `spin/pivot` 机制：同一 pivot + 同一 speed 的节点，
 * `syncParts` 每帧按绝对角度转 ⇒ 整轮同步；小轮取负速且按半径比放大 ⇒ 真的在啮合。
 */
export function gearFactoryModel(accent: number): ArenaModel {
  // 齿轮贴在前墙（墙皮 z=0.52）上，盘厚 0.08 ⇒ z 0.52~0.60，既不插墙也不悬空
  const GEAR: Vec3 = [-0.30, 0.82, 0.56];  // 大轮：圆盘 r=0.26、齿顶 0.30
  const SMALL: Vec3 = [0.16, 0.62, 0.56];  // 小轮：圆盘 r=0.14、齿顶 0.18；中心距 0.50 ≈ 0.30+0.18
  const BIG_SPEED = 0.9;
  const SMALL_SPEED = -1.5; // 反向、快约 1.67 倍（≈ 齿数比 12/8）
  const spinPart = (node: Node, pivot: Vec3, speed: number): Node => ({ ...node, spin: speed, pivot });
  const out: Node[] = [
    // ---- 厂房本体：全部收在 x ±0.86 / z ±0.60 内
    plinth([1.72, 0.07, 1.2], ARENA_PAL.stoneDark),
    box([1.64, 0.3, 1.12], ARENA_PAL.stone, [0, mid(0.07, 0.3), 0]),
    // 里子比外壳**小一圈**（每边 0.10）：外壳面片只占 0.06 厚，里子必须退到内皮以内，
    // 否则两者同面 —— 实机上就是墙面闪烁（z-fighting），墙板掉了也看不出"洞"。
    // 老楼（民居 1.14→0.94、兵营 1.42→1.2、大本营 1.42→1.06）都是这个口径。
    box([1.36, 0.82, 0.84], ARENA_PAL.wallDark, [0, mid(0.37, 0.82), 0]),
    // 木骨架：四角立柱 + 两道横箍
    ...[-0.7, 0.7].flatMap((x) => [
      box([0.08, 0.82, 0.07], ARENA_PAL.wood, [x, mid(0.37, 0.82), 0.53]),
      box([0.08, 0.82, 0.07], ARENA_PAL.wood, [x, mid(0.37, 0.82), -0.53]),
    ]),
    box([1.5, 0.07, 0.07], ARENA_PAL.woodLight, [0, 0.62, 0.54]),
    box([1.5, 0.07, 0.07], ARENA_PAL.woodLight, [0, 1.1, 0.54]),
    // 大门挪到右边，给左边的齿轮腾出整片墙
    box([0.34, 0.52, 0.05], ARENA_PAL.wood, [0.5, mid(0.37, 0.52), 0.55]),
    box([0.38, 0.05, 0.06], ARENA_PAL.woodLight, [0.5, 0.91, 0.56]),
    // 两扇小窗开在后墙，不跟齿轮抢同一面
    box([0.2, 0.22, 0.05], ARENA_PAL.stoneDark, [-0.48, 0.9, -0.54]),
    box([0.2, 0.22, 0.05], ARENA_PAL.stoneDark, [0.48, 0.9, -0.54]),
    /**
     * **钝角缓坡顶**（P-095，用户："希望它的顶是钝角顶，整个建筑稍微矮一点"）。
     * 屋脊高 0.32 → 0.14，半跨 0.85 ⇒ 坡度约 9°、脊角约 161°（钝角），
     * 再用一条宽 0.18 的压顶盖住尖脊，远看是"钝顶"而不是尖尖的人字顶。
     * 整栋总高 1.87 → 1.59 模型单位（4.11 → 3.50 格）。
     * ⚠️ **侧面齿轮一件不动**：GEAR / SMALL 的坐标、半径、齿数、转速全部原样，
     * 墙高也保持 1.19 —— 只动 1.19 以上的屋顶和烟囱。
     */
    prism([1.7, 0.14, 1.16], roofOf(accent), [0, 1.19, 0]),
    box([1.74, 0.06, 0.34], ridgeOf(accent), [0, mid(1.33, 0.06), 0]),
    // ---- 两根烟囱跟着压矮：底部仍埋进屋顶 0.08，不留穿缝
    ...[-0.52, 0.52].flatMap((x) => [
      cyl([0.085, 0.1, 0.28], ARENA_PAL.stone, [x, mid(1.25, 0.28), -0.3], 8),
      box([0.2, 0.06, 0.2], ridgeOf(accent), [x, mid(1.53, 0.06), -0.3]),
    ]),
  ];
  // ---- 大齿轮：圆盘 + 12 齿 + 4 辐条 + 金色轴心（同一 pivot/speed 同步转）
  out.push(spinPart({
    part: { kind: 'cyl', rTop: 0.26, rBottom: 0.26, height: 0.08, seg: 12 },
    color: ARENA_PAL.iron, at: GEAR, rot: [Math.PI / 2, 0, 0],
  }, GEAR, BIG_SPEED));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    out.push(spinPart({
      part: { kind: 'box', size: [0.1, 0.1, 0.08] },
      color: 0x8a7350,
      at: [GEAR[0] + Math.cos(a) * 0.3, GEAR[1] + Math.sin(a) * 0.3, GEAR[2]],
      rot: [0, 0, a],
    }, GEAR, BIG_SPEED));
  }
  for (let i = 0; i < 4; i++) {
    out.push(spinPart({
      part: { kind: 'box', size: [0.44, 0.05, 0.05] },
      color: ARENA_PAL.woodLight, at: GEAR, rot: [0, 0, (i * Math.PI) / 4],
    }, GEAR, BIG_SPEED));
  }
  out.push(spinPart({
    part: { kind: 'cyl', rTop: 0.07, rBottom: 0.07, height: 0.12, seg: 8 },
    color: ARENA_PAL.gold, at: GEAR, rot: [Math.PI / 2, 0, 0],
  }, GEAR, BIG_SPEED));
  // ---- 咬合小齿轮：8 齿，反向且更快
  out.push(spinPart({
    part: { kind: 'cyl', rTop: 0.14, rBottom: 0.14, height: 0.07, seg: 10 },
    color: ARENA_PAL.iron, at: SMALL, rot: [Math.PI / 2, 0, 0],
  }, SMALL, SMALL_SPEED));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    out.push(spinPart({
      part: { kind: 'box', size: [0.07, 0.07, 0.07] },
      color: 0x8a7350,
      at: [SMALL[0] + Math.cos(a) * 0.18, SMALL[1] + Math.sin(a) * 0.18, SMALL[2]],
      rot: [0, 0, a],
    }, SMALL, SMALL_SPEED));
  }
  out.push(spinPart({
    part: { kind: 'cyl', rTop: 0.05, rBottom: 0.05, height: 0.1, seg: 8 },
    color: ARENA_PAL.gold, at: SMALL, rot: [Math.PI / 2, 0, 0],
  }, SMALL, SMALL_SPEED));
  return {
    static: out,
    // 施工外壳与砖墙**同一个轮廓、同一个高度**（旧版 y0=0.06 和墙 0.48 完全错位）
    shell: boxShell(1.56, 1.04, 0.37, 0.82, ARENA_PAL.wall, 4, 2, 97),
  };
}

/**
 * **兽人巢穴**（2026-11-07 用户新增，同日傍晚改型）：**半圆地堡**。
 *
 * 用户第二轮原话："兽人巢穴设计特色化，要一个半圆地堡感。" 上一版是方盒子 +
 * 人字坡顶（本质是个"矮民居"），换成"扣在地上的碗"才有兽人挖出来的土堡感：
 *
 * ```
 *      穹顶 dome 0.62×0.46           ← 半圆顶，2.2 倍后 ≈1.36 格半径 / 2.02 格高
 *      檐口箍（阵营色）              ← 盖住"筒身 ↔ 穹顶"的接缝，也是一眼分敌我的那道色
 *      筒身（可掉落墙板 12×2 片）
 *      暗内衬圆筒                    ← 墙板掉了能看见里面，不是实心块
 *      圆形台基
 * ```
 *
 * 门是**半圆拱**：一枚横放的圆盘（半径 0.22、厚 0.06）中心压在台基顶面附近，
 * 下半被台基吃掉，露出来的正好是半圆 —— 不用另做"拱形"图元。
 *
 * 里子必须比外壳小一圈（用户同一天指出的共面问题）：内衬 r=0.52 对壳 r=0.60，
 * 每边留 0.08 的缝，掉墙看得见洞。
 *
 * 只要花钱 + 有空位就能盖，不需要民居 / 磨坊（`needsStaffing` 不列它），
 * 但解锁兽人军队要等**完工**，和兵营 / 齿轮工厂同一条科技法律。
 */
export function orcLairModel(accent: number): ArenaModel {
  const tusk = 0xd9cda8;
  const SHELL_R = 0.6;
  // 筒身 0.46 / 穹顶 0.36：筒身矮、穹顶一高就是"蘑菇"，地堡要**扁顶 + 高一点的墙**
  // （墙也是可掉落面片，抬高了掉墙才看得出来）
  const WALL_H = 0.46;
  const DOME_H = 0.36;
  // 夯土顶：比墙片（wall 浅米）沉一档，才像"从土里拱出来的"，不是一个白馒头
  const DOME_C = mix(ARENA_PAL.wall, ARENA_PAL.wallDark, 0.62);
  /**
   * **真·羊角**（P-095，用户："它上面的那两个角太细了，我希望他是真正的羊角建模"）。
   *
   * 旧版是两根 `box([0.06, 0.42, 0.06])` 细方棍斜插在穹顶上 —— 又细又直，
   * 像天线不像角。现在每根角 = **5 段渐细的锥台**（第一段特意加粗兼作角根护套），
   * 沿一段圆弧（半径 0.30、总弯角 77°）逐段绕 Z 转向：
   * 根粗 0.15 一路收尖，段间深浅交替形成羊角特有的环纹，
   * 整体向外上方再卷回来，是有体积、有弧度的角，不是棍子。
   *
   * 用锥台而不是 cone：羊角是"钝头渐细的角"，不是尖锥；
   * 段与段之间留 0.02 重叠，接缝不会漏光。每侧 5 件、两侧 10 件，
   * 替换旧骨刺 2 件后整栋仍在 22 件体型锁内。
   */
  const horn = (side: -1 | 1): Node[] => {
    const SEG = 5;
    const BEND_R = 0.32;
    const SWEEP = 1.5;
    const R_BASE = 0.15;
    const X0 = side * 0.34;
    const Y0 = 0.72;
    const Z0 = -0.16;
    const segH = (BEND_R * SWEEP) / SEG + 0.02;
    const out: Node[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = ((i + 0.5) / SEG) * SWEEP;
      const x = X0 + side * BEND_R * (1 - Math.cos(a));
      const y = Y0 + BEND_R * Math.sin(a);
      // 第一段根部额外加粗 0.05：不用单独一件护套，角根也有"长在穹顶上"的体积
      const root = i === 0 ? 0.05 : 0;
      const rBottom = R_BASE * (1 - (i / SEG) * 0.72) + root;
      const rTop = R_BASE * (1 - ((i + 1) / SEG) * 0.72);
      out.push({
        ...cyl([rTop, rBottom, segH], i % 2 ? shade(tusk, 0.82) : tusk, [x, y, Z0], 8),
        rot: [0, 0, -side * a],
      });
    }
    return out;
  };
  const out: Node[] = [
    // 圆形台基：比筒身大 0.06，破一下"直上直下"的边
    cyl([0.66, 0.66, 0.08], ARENA_PAL.stoneDark, [0, mid(0, 0.08), 0], 14),
    // 暗内衬：r 0.52 < 壳 0.60，墙板掉了看见的是它（不是实心墙）
    cyl([0.52, 0.52, WALL_H], ARENA_PAL.inside, [0, mid(0.08, WALL_H), 0], 14),
    // 半圆穹顶：底面正好落在筒身顶上（0.08 + 0.38 = 0.46）
    // 半径比筒身**小 0.02**：穹顶坐进去，筒身外皮（可掉落墙板）才露得出来 ——
    // 反过来写成 0.62 会把整圈墙板罩在檐下，墙掉了玩家也看不见
    dome(0.58, DOME_H, DOME_C, [0, 0.08 + WALL_H, 0], 14),
    // 檐口箍：压住筒身与穹顶的接缝，阵营色 —— 远看那一圈就能认人
    cyl([0.63, 0.63, 0.06], ridgeOf(accent), [0, 0.08 + WALL_H, 0], 14),
    // 半圆拱门：横放圆盘，下半沉进台基 ⇒ 露出上半圆
    // 圆盘必须**贴在墙外皮之外**（0.62 > 0.60），埋在墙里就整块被面片盖住了
    { ...cyl([0.2, 0.2, 0.06], ARENA_PAL.inside, [0, 0.2, SHELL_R + 0.02], 12), rot: [Math.PI / 2, 0, 0] },
    // 拱脚：把门洞下半补成直墙，免得看起来是"一个悬空的圆"
    box([0.4, 0.2, 0.06], ARENA_PAL.inside, [0, mid(0.08, 0.2), SHELL_R + 0.02]),
    // 门楣（木）+ 一对獠牙
    box([0.54, 0.06, 0.1], ARENA_PAL.wood, [0, 0.42, SHELL_R + 0.03]),
    { ...cone(0.07, 0.34, tusk, [-0.31, 0.46, SHELL_R + 0.03], 7), rot: [0, 0, 0.22] },
    { ...cone(0.07, 0.34, tusk, [0.31, 0.46, SHELL_R + 0.03], 7), rot: [0, 0, -0.22] },
    // 穹顶上一对弯羊角：替代原来两根细骨刺，剪影不再是一个光滑的半球
    ...horn(-1),
    ...horn(1),
    // 两侧石墩：像地堡外的掩体
    box([0.16, 0.22, 0.26], ARENA_PAL.stone, [-0.58, mid(0.08, 0.22), 0.18]),
    box([0.16, 0.22, 0.26], ARENA_PAL.stone, [0.58, mid(0.08, 0.22), 0.18]),
  ];
  return {
    static: out,
    // 圆壳：筒身一圈 12 段 × 2 行 = 24 片，和方楼同一套掉落逻辑
    shell: ringShell(SHELL_R, SHELL_R, 0.08, WALL_H, ARENA_PAL.wall, 12, 2, 91),
  };
}

/**
 * 商行（P-093 新增，P-095 精致化）：民居的体量 + **匾额 / 斜布篷 / 门柱 / 货箱 / 柜台**。
 *
 * P-093 那版只在民居骨架上贴了一块金招牌 + 一条柜台，远看和民居几乎一样 ——
 * 用户 2026-11-10 点名「新增的几个建筑不好看、重复性太高」。
 * 现在用铺面该有的五件把它拉开：金框匾额（内嵌深色字板）、撑起来的条纹布篷、
 * 两根门柱、两侧货箱、门口柜台。民居仍是"小屋 + 烟囱"，商行一眼是"开张的铺子"。
 *
 * 只加 `static` 件，**可掉落外壳继续复用民居的 boxShell**（同一套损伤表现），
 * 总件数 20 仍在 22 件体型锁内。
 */
export function guildModel(accent: number): ArenaModel {
  const base = houseModel(accent);
  return {
    ...base,
    static: [
      ...base.static,
      // 金框匾额 + 深色字板：不再是"一整块金砖"
      box([1.0, 0.26, 0.07], ARENA_PAL.gold, [0, 0.62, 0.52]),
      box([0.86, 0.16, 0.08], ARENA_PAL.wood, [0, 0.62, 0.56]),
      // 斜撑布篷：阵营色偏米，往镜头这侧探出来
      { ...box([1.06, 0.05, 0.36], clothOf(accent), [0, 0.48, 0.62]), rot: [0.3, 0, 0] },
      // 两根门柱把篷撑住，别像悬空的一块板
      ...[-0.48, 0.48].map((x) =>
        cyl([0.04, 0.05, 0.46], ARENA_PAL.woodLight, [x, mid(0.06, 0.46), 0.72], 6)),
      // 两侧货箱
      ...[-0.64, 0.64].map((x) =>
        box([0.22, 0.18, 0.2], ARENA_PAL.wood, [x, mid(0.06, 0.18), 0.6])),
      // 门口柜台：矮、宽、探出墙面
      box([0.78, 0.16, 0.26], ARENA_PAL.woodLight, [0, mid(0.06, 0.16), 0.66]),
    ],
  };
}

/** 名字 → 造模型。视图层只读这张表；`accent` 是阵营色。 */
export const ARENA_MODELS = {
  core: coreModel,
  barracks: barracksModel,
  arrowTower: arrowTowerModel,
  cannonTower: cannonTowerModel,
  mill: millModel,
  guild: guildModel,
  house: houseModel,
  gearFactory: gearFactoryModel,
  orcLair: orcLairModel,
} as const;

export type ArenaModelName = keyof typeof ARENA_MODELS;

/**
 * 旗子的落点（**格**，不是模型单位）。
 *
 * 上一版把旗挂在 z 为负的那面 —— 那是背对镜头的墙，所以旗子总像"埋进楼里"。
 * 这一版全部放在**镜头这一侧**（z 为正）或屋顶/垛口上：
 * - 大本营：前墙、檐口下面（竖旗从杆上垂下，正是他要的"挂在墙上、从上往下"）
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
  // P-095 平顶 + 墙垛：屋顶顶 1.20×2.2 ≈ 2.64 格，旗立在垛口旁的压顶上。
  // 旧值 2.95 是给「双坡屋脊 1.34」那版的，平顶后会悬空 0.3 格。
  barracks: { x: 1.6, z: 0, base: 2.6, pole: 0.9 },
  arrowTower: { x: 1.1, z: 1.1, base: 4.75, pole: 0.85 },
  cannonTower: { x: 1.45, z: 1.45, base: 0.12, pole: 2.1 },
  mill: { x: 0, z: 0, base: 5.25, pole: 0.9 },
  house: { x: 1.2, z: 0, base: 2.55, pole: 0.8 },
  guild: { x: 1.2, z: 0, base: 2.55, pole: 0.8 }, // 沿用民居屋脊高度（商行复用民居骨架）
  // P-095 钝角缓坡顶：屋脊 1.33×2.2 ≈ 2.93 格（旧版 1.52 → 3.34 格），
  // 旗跟着降，别留在半空。侧面齿轮一件没动。
  gearFactory: { x: 1.05, z: 0.2, base: 2.95, pole: 1.1 },
  // P-095 弯羊角长出穹顶后总高约 2.33 格；旗插在角根旁的穹顶侧面。
  // 旧值 1.4 是给「穹顶 1.98 格 + 两根细骨刺」那版的，新角高出后会插进角里。
  orcLair: { x: 0.92, z: -0.1, base: 1.7, pole: 0.95 },
};
