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
 * 兵营：长屋 + 双坡脊 + 大门 + 檐柱 + 兵器架；墙片掉了露出三根木柱和一根横梁。
 */
export function barracksModel(accent: number): ArenaModel {
  return {
    static: [
      plinth([1.5, 0.06, 1.16], ARENA_PAL.stoneDark),
      box([1.45, 0.16, 1.02], ARENA_PAL.stoneDark, [0, mid(0.06, 0.16), 0]),
      prism([1.62, 0.5, 1.14], roofOf(accent), [0, 0.84, 0]),
      // 屋脊 + 两道檐口：阵营色，扫一眼就知道这排营房是谁的
      box([1.66, 0.07, 0.12], ridgeOf(accent), [0, mid(1.32, 0.07), 0]),
      box([1.64, 0.05, 0.1], ARENA_PAL.roofDark, [0, mid(1.32, 0.05), 0]),
      box([0.34, 0.46, 0.06], ARENA_PAL.wood, [0, mid(0.22, 0.46), 0.52]),
      box([0.44, 0.05, 0.07], ARENA_PAL.woodLight, [0, 0.7, 0.52]),
      cyl([0.035, 0.04, 0.6], ARENA_PAL.wood, [-0.62, mid(0.22, 0.6), 0.46], 5),
      cyl([0.035, 0.04, 0.6], ARENA_PAL.wood, [0.62, mid(0.22, 0.6), 0.46], 5),
      cyl([0.022, 0.026, 0.9], ARENA_PAL.woodLight, [0.55, mid(0.06, 0.9), 0.62], 5),
      cyl([0.022, 0.026, 0.9], ARENA_PAL.woodLight, [0.64, mid(0.06, 0.9), 0.64], 5),
      box([0.14, 0.04, 0.04], ARENA_PAL.iron, [0.595, 0.66, 0.63]),
      // 屋内：内衬 + 三根柱 + 一根横梁
      box([1.2, 0.62, 0.74], ARENA_PAL.inside, [0, mid(0.22, 0.62), 0]),
      cyl([0.03, 0.035, 0.62], ARENA_PAL.wood, [-0.44, mid(0.22, 0.62), 0.26], 5),
      cyl([0.03, 0.035, 0.62], ARENA_PAL.wood, [0, mid(0.22, 0.62), 0.26], 5),
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
 * 复古厂房：石台 + 砖墙 + 木梁 + 双坡顶 + 烟囱；前墙外挂一枚**大齿轮**
 * （圆盘 12 齿 4 辐条）和一枚咬合的小齿轮（反向转）。
 * 齿轮复用磨坊帆的 `spin/pivot` 机制：同一 pivot + 同一 speed 的节点，
 * `syncParts` 每帧按绝对角度转 ⇒ 整轮同步「转转转」。
 */
export function gearFactoryModel(accent: number): ArenaModel {
  const GEAR: Vec3 = [0.62, 1.15, 0.95];   // 大齿轮中心（前墙外侧，朝镜头）
  const SMALL: Vec3 = [-0.42, 0.72, 0.95]; // 咬合的小齿轮
  const spinPart = (node: Node, pivot: Vec3, speed: number): Node => ({ ...node, spin: speed, pivot });
  const out: Node[] = [
    // ---- 复古厂房本体（4×3 占地，比 3×3 楼宽一圈）
    plinth([2.3, 0.08, 1.5], ARENA_PAL.stoneDark),
    box([2.15, 0.4, 1.4], ARENA_PAL.stone, [0, mid(0.08, 0.4), 0]),
    box([1.95, 1.15, 1.25], ARENA_PAL.wallDark, [0, mid(0.48, 1.15), 0]),
    // 木梁：四角立柱 + 两道横箍（复古木骨架）
    ...[-0.88, 0.88].flatMap((x) => [
      box([0.1, 1.15, 0.08], ARENA_PAL.wood, [x, mid(0.48, 1.15), 0.64]),
      box([0.1, 1.15, 0.08], ARENA_PAL.wood, [x, mid(0.48, 1.15), -0.64]),
    ]),
    box([1.9, 0.09, 0.09], ARENA_PAL.woodLight, [0, 1.0, 0.64]),
    box([1.9, 0.09, 0.09], ARENA_PAL.woodLight, [0, 1.52, 0.64]),
    // 大门 + 两扇小窗
    box([0.46, 0.68, 0.07], ARENA_PAL.wood, [-0.25, mid(0.48, 0.68), 0.66]),
    box([0.5, 0.06, 0.09], ARENA_PAL.woodLight, [-0.25, 0.75, 0.68]),
    box([0.26, 0.3, 0.06], ARENA_PAL.stoneDark, [0.55, 1.15, 0.66]),
    box([0.26, 0.3, 0.06], ARENA_PAL.stoneDark, [0.55, 1.15, -0.66]),
    // 双坡顶 + 屋脊
    prism([2.15, 0.5, 1.45], roofOf(accent), [0, 1.9, 0]),
    box([2.2, 0.08, 0.12], ridgeOf(accent), [0, mid(2.15, 0.08), 0]),
    // 烟囱（左后）+ 顶箍
    cyl([0.18, 0.22, 1.0], ARENA_PAL.stone, [-0.75, 2.15, -0.38], 8),
    box([0.28, 0.08, 0.28], ridgeOf(accent), [-0.75, 2.68, -0.38]),
  ];
  // ---- 大齿轮：圆盘 + 12 齿 + 4 辐条 + 金色轴心（全部同一 pivot/speed 同步转）
  out.push(spinPart({
    part: { kind: 'cyl', rTop: 0.5, rBottom: 0.5, height: 0.14, seg: 12 },
    color: ARENA_PAL.iron, at: GEAR, rot: [Math.PI / 2, 0, 0],
  }, GEAR, 0.8));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    out.push(spinPart({
      part: { kind: 'box', size: [0.16, 0.16, 0.14] },
      color: 0x8a7350,
      at: [GEAR[0] + Math.cos(a) * 0.56, GEAR[1] + Math.sin(a) * 0.56, GEAR[2]],
      rot: [0, 0, a],
    }, GEAR, 0.8));
  }
  for (let i = 0; i < 4; i++) {
    out.push(spinPart({
      part: { kind: 'box', size: [0.82, 0.08, 0.08] },
      color: ARENA_PAL.woodLight, at: GEAR, rot: [0, 0, (i * Math.PI) / 4],
    }, GEAR, 0.8));
  }
  out.push(spinPart({
    part: { kind: 'cyl', rTop: 0.11, rBottom: 0.11, height: 0.2, seg: 8 },
    color: ARENA_PAL.gold, at: GEAR, rot: [Math.PI / 2, 0, 0],
  }, GEAR, 0.8));
  // ---- 咬合小齿轮：反向转，机械感
  out.push(spinPart({
    part: { kind: 'cyl', rTop: 0.27, rBottom: 0.27, height: 0.12, seg: 10 },
    color: ARENA_PAL.iron, at: SMALL, rot: [Math.PI / 2, 0, 0],
  }, SMALL, -1.2));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    out.push(spinPart({
      part: { kind: 'box', size: [0.11, 0.11, 0.12] },
      color: 0x8a7350,
      at: [SMALL[0] + Math.cos(a) * 0.31, SMALL[1] + Math.sin(a) * 0.31, SMALL[2]],
      rot: [0, 0, a],
    }, SMALL, -1.2));
  }
  return {
    static: out,
    shell: boxShell(1.95, 1.25, 0.06, 1.15, ARENA_PAL.wall, 4, 2, 97),
  };
}

/** 名字 → 造模型。视图层只读这张表；`accent` 是阵营色。 */
export const ARENA_MODELS = {
  core: coreModel,
  barracks: barracksModel,
  arrowTower: arrowTowerModel,
  cannonTower: cannonTowerModel,
  mill: millModel,
  house: houseModel,
  gearFactory: gearFactoryModel,
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
  barracks: { x: 1.6, z: 0, base: 2.95, pole: 0.9 },
  arrowTower: { x: 1.1, z: 1.1, base: 4.75, pole: 0.85 },
  cannonTower: { x: 1.45, z: 1.45, base: 0.12, pole: 2.1 },
  mill: { x: 0, z: 0, base: 5.25, pole: 0.9 },
  house: { x: 1.2, z: 0, base: 2.55, pole: 0.8 },
  gearFactory: { x: 0.95, z: 0, base: 2.25, pole: 2.0 },
};
