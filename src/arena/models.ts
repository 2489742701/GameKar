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
 * 议事厅（核心）：石台 + 石裙 + **方墙（面片）** + 四角柱 + 四坡顶 + 水晶。
 * 墙里有木骨架 + 暗色内衬：墙片掉了能看见梁柱。
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
        color: ARENA_PAL.roof,
        at: [0, mid(1.72, 0.66), 0],
        rot: [0, Math.PI / 4, 0],
      },
      crystal(0.2, 0.62, accent, [0, mid(2.28, 0.62), 0]),
      // 屋内：暗色内衬（洞的"深度"）+ 木骨架
      box([1.06, 1.0, 1.06], ARENA_PAL.inside, [0, mid(0.57, 1.0), 0]),
      cyl([0.035, 0.04, 1.0], ARENA_PAL.wood, [-0.52, mid(0.57, 1.0), -0.52], 5),
      cyl([0.035, 0.04, 1.0], ARENA_PAL.wood, [0.52, mid(0.57, 1.0), -0.52], 5),
      cyl([0.035, 0.04, 1.0], ARENA_PAL.wood, [-0.52, mid(0.57, 1.0), 0.52], 5),
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
export function barracksModel(): ArenaModel {
  return {
    static: [
      plinth([1.5, 0.06, 1.16], ARENA_PAL.stoneDark),
      box([1.45, 0.16, 1.02], ARENA_PAL.stoneDark, [0, mid(0.06, 0.16), 0]),
      prism([1.62, 0.5, 1.14], ARENA_PAL.roof, [0, 0.84, 0]),
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
export function arrowTowerModel(): ArenaModel {
  return {
    static: [
      plinth([1.12, 0.06, 1.12], ARENA_PAL.stoneDark),
      cyl([0.5, 0.6, 0.5], ARENA_PAL.stone, [0, mid(0.06, 0.5), 0], 10),
      cyl([0.58, 0.58, 0.07], ARENA_PAL.stoneDark, [0, mid(1.61, 0.07), 0], 10),
      cyl([0.68, 0.55, 0.22], ARENA_PAL.stone, [0, mid(1.68, 0.22), 0], 10),
      box([0.22, 0.3, 0.22], ARENA_PAL.stone, [-0.5, mid(1.9, 0.3), -0.5]),
      box([0.22, 0.3, 0.22], ARENA_PAL.stone, [0.5, mid(1.9, 0.3), -0.5]),
      box([0.22, 0.3, 0.22], ARENA_PAL.stone, [-0.5, mid(1.9, 0.3), 0.5]),
      box([0.22, 0.3, 0.22], ARENA_PAL.stone, [0.5, mid(1.9, 0.3), 0.5]),
      box([0.09, 0.3, 0.05], ARENA_PAL.stoneDark, [0, mid(1.0, 0.3), 0.545]),
      box([0.05, 0.3, 0.09], ARENA_PAL.stoneDark, [0.545, mid(1.0, 0.3), 0]),
      box([0.05, 0.3, 0.09], ARENA_PAL.stoneDark, [-0.545, mid(1.0, 0.3), 0]),
      cone(0.5, 0.8, ARENA_PAL.roof, [0, mid(1.9, 0.8), 0], 8),
      sphere(0.06, ARENA_PAL.gold, [0, 2.74, 0], 1),
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
 * 磨坊：石塔 + 木栈道 + 阵营色顶盖 + 四片帆。
 * 塔身是面片，掉了露出内筒、木肋和两层楼板。
 */
export function millModel(accent: number): ArenaModel {
  const PIVOT: Vec3 = [0, 1.5, 0.68];
  const sail = (node: Node): Node => ({ ...node, spin: 1.7, pivot: PIVOT });
  return {
    static: [
      plinth([1.12, 0.06, 1.12], ARENA_PAL.stoneDark),
      cyl([0.64, 0.64, 0.05], ARENA_PAL.wood, [0, mid(1.28, 0.05), 0], 10),
      box([0.28, 0.46, 0.06], ARENA_PAL.wood, [0, mid(0.06, 0.46), 0.56]),
      cyl([0.64, 0.64, 0.06], ARENA_PAL.roofDark, [0, mid(1.56, 0.06), 0], 10),
      { ...cone(0.58, 0.78, accent, [0, mid(1.62, 0.78), 0], 10), paint: { rough: 0.85 } },
      {
        part: { kind: 'cyl', rTop: 0.07, rBottom: 0.08, height: 0.22, seg: 8 },
        color: ARENA_PAL.iron,
        at: [0, 1.5, 0.6],
        rot: [Math.PI / 2, 0, 0],
      },
      sail({ ...box([0.06, 1.2, 0.04], ARENA_PAL.wood, [0, 1.5, 0.68]), rot: [0, 0, Math.PI / 4] }),
      sail({ ...box([0.06, 1.2, 0.04], ARENA_PAL.wood, [0, 1.5, 0.68]), rot: [0, 0, -Math.PI / 4] }),
      sail({ ...box([0.24, 0.56, 0.03], 0xe6d8b4, [0.106, 1.846, 0.68]), rot: [0, 0, Math.PI / 4] }),
      sail({ ...box([0.24, 0.56, 0.03], 0xe6d8b4, [-0.106, 1.154, 0.68]), rot: [0, 0, Math.PI / 4] }),
      sail({ ...box([0.24, 0.56, 0.03], 0xe6d8b4, [-0.346, 1.606, 0.68]), rot: [0, 0, -Math.PI / 4] }),
      sail({ ...box([0.24, 0.56, 0.03], 0xe6d8b4, [0.346, 1.394, 0.68]), rot: [0, 0, -Math.PI / 4] }),
      // 屋内：暗色内筒 + 四根木肋 + 两层楼板
      cyl([0.4, 0.4, 1.5], ARENA_PAL.inside, [0, mid(0.06, 1.5), 0], 10),
      cyl([0.035, 0.04, 1.5], ARENA_PAL.wood, [0.46, mid(0.06, 1.5), 0], 5),
      cyl([0.035, 0.04, 1.5], ARENA_PAL.wood, [-0.46, mid(0.06, 1.5), 0], 5),
      cyl([0.035, 0.04, 1.5], ARENA_PAL.wood, [0, mid(0.06, 1.5), 0.46], 5),
      cyl([0.035, 0.04, 1.5], ARENA_PAL.wood, [0, mid(0.06, 1.5), -0.46], 5),
      cyl([0.52, 0.52, 0.05], ARENA_PAL.woodLight, [0, mid(0.5, 0.05), 0], 10),
      cyl([0.48, 0.48, 0.05], ARENA_PAL.woodLight, [0, mid(1.2, 0.05), 0], 10),
    ],
    shell: ringShell(0.62, 0.46, 0.06, 1.5, ARENA_PAL.wall, 10, 4, 67),
  };
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
  mill: { x: 0, z: 0, base: 5.25, pole: 0.9 },
};
