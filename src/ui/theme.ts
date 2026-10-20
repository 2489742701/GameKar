/**
 * 界面材质 —— 木质面板 + 镀金按键，全部现算，不引任何图片资产。
 *
 * 为什么用噪声而不是直接渐变：中世纪那种"面板是块木头"的感觉，
 * 靠渐变只会得到塑料；要的是**有起伏、有色阶、有板缝**的颗粒。
 * 像素化也不靠滤镜：图本身就只生成 48×48，再按整数倍放大 + `image-rendering: pixelated`，
 * 所以放大后看到的是真方块，不是糊。
 *
 * 分两层写是有理由的：
 *   `woodPixels()` / `giltPixels()` 是纯函数（node 里能断言档数、平铺、复现），
 *   `installTheme()` 才碰 canvas 和 DOM。测试不需要开浏览器就能证明噪声没写错。
 *
 * 平铺噪声不复用 `engine/math/Noise.ts`：那份的格点是无限散列，
 * tile 左右边缘接不上，平铺会看见一条缝。这里用"格点序号取模"的周期版 ——
 * 形状一样，多一个 period。语义不同，所以不硬并成一个函数。
 */

import { remap } from '@engine/math/Noise';

/** 用户给的那一族颜色：深黑 → 深黑褐 → 深褐 → 暗木 → 深木 → 木 → 黄褐 → 深黄。 */
export const WOOD_RAMP = [
  '#120b06',
  '#1c1108',
  '#2a1a0e',
  '#3b2412',
  '#4e3116',
  '#65401b',
  '#7f5320',
  '#a86f26',
] as const;

/** 镀金从暗到亮：底影 / 本体 / 高光 / 镜面一线。 */
export const GILT_RAMP = ['#6b4a15', '#a8792a', '#d9b25c', '#f6dc9c'] as const;

export interface WoodSpec {
  /** tile 边长（像素）。越小放大后方块越大 —— 这就是"像素化"的那一维 */
  size: number;
  /** 亮度量化成几档。档数越少越像旧游戏的手绘木板 */
  steps: number;
  seed: number;
  /** 横纹在 x / y 方向各给几个格点：x 少 y 多 = 条纹被拉成长 */
  grainX: number;
  grainY: number;
  /** 大尺度弯曲（板面不平）的格点数，取整数才平铺得上 */
  warpX: number;
  warpY: number;
  /** 几像素一块板；每块板顶边压暗，读作板缝 */
  plankRows: number;
  /** 板缝压暗多少（0 = 没有板缝）。做成参数是为了能对着"关掉板缝"的那一份比一次 */
  seam: number;
  /** 整体明度：0.5 是色板正中 */
  brightness: number;
  /** 不透明度：留一点让底下的面板色透上来，别把地图糊死 */
  alpha: number;
}

export const DEFAULT_WOOD: WoodSpec = {
  size: 48,
  steps: 6,
  seed: 20261020,
  grainX: 3,
  grainY: 13,
  warpX: 2,
  warpY: 3,
  plankRows: 12,
  seam: 0.2,
  brightness: 0.44,
  alpha: 236,
};

export interface GiltSpec {
  size: number;
  steps: number;
  seed: number;
  /** 拉丝方向：横向 = 顺着按钮边 */
  streaks: number;
  alpha: number;
}

export const DEFAULT_GILT: GiltSpec = { size: 64, steps: 4, seed: 4711, streaks: 26, alpha: 120 };

function hash2(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (v: number, period: number) => ((v % period) + period) % period;

/**
 * 周期值噪声：`u, v` 取 [0,1) 时正好铺满一张 tile。
 * 格点序号先取模再散列，所以第 0 列与最后一列的邻接格是同一个点 —— 无缝。
 */
export function tileNoise(u: number, v: number, periodX: number, periodY: number, seed: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = fade(x - xi);
  const ty = fade(y - yi);

  const x0 = wrap(xi, periodX);
  const x1 = wrap(xi + 1, periodX);
  const y0 = wrap(yi, periodY);
  const y1 = wrap(yi + 1, periodY);

  return lerp(
    lerp(hash2(x0, y0, seed), hash2(x1, y0, seed), tx),
    lerp(hash2(x0, y1, seed), hash2(x1, y1, seed), tx),
    ty,
  );
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const parseHex = (hex: string): Rgb => {
  const v = hex.replace('#', '');
  const n = Number.parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/** 亮度档 → 色板下标。档数少于色板长度时是"挑色板里等距的几档"，不是插值：保持硬边。 */
export function rampIndex(step: number, steps: number, rampLength: number): number {
  const clamped = Math.min(steps - 1, Math.max(0, step));
  return Math.round(remap(clamped, 0, steps - 1, 0, rampLength - 1));
}

/**
 * 木纹像素：三层噪声（大弯 → 长横纹 → 细颗粒）加权求和，量化成 steps 档。
 * 返回 size*size*4 的 RGBA，行优先。
 */
export function woodPixels(spec: WoodSpec = DEFAULT_WOOD): Uint8ClampedArray {
  const { size, steps, seed, grainX, grainY, warpX, warpY, plankRows, seam, brightness, alpha } = spec;
  const out = new Uint8ClampedArray(size * size * 4);
  const ramp = WOOD_RAMP.map(parseHex);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // 板缝：每块板的顶边整条压暗，第二行压一半，读作"这是几块板拼的"
    const seamDark = y % plankRows === 0 ? -seam : y % plankRows === 1 ? -seam * 0.35 : 0;

    for (let x = 0; x < size; x++) {
      const u = x / size;
      const warp = tileNoise(u, v, warpX, warpY, seed + 11) - 0.5;
      // 条纹的 y 坐标被 warp 推来推去：板面不平，纹就跟着弯
      const band = tileNoise(u, v + warp * 0.055, grainX, grainY, seed);
      const fine = tileNoise(u, v, grainX * 8, grainY * 2, seed + 777);

      let t = brightness + (band - 0.5) * 0.62 + (fine - 0.5) * 0.22 + seamDark;
      t = Math.min(1, Math.max(0, t));

      const color = ramp[rampIndex(Math.floor(t * steps), steps, ramp.length)]!;
      const i = (y * size + x) * 4;
      out[i] = color.r;
      out[i + 1] = color.g;
      out[i + 2] = color.b;
      out[i + 3] = alpha;
    }
  }
  return out;
}

/** 镀金拉丝：横向细纹 + 一档高光线，压在金色渐变上当"镀"的那层。 */
export function giltPixels(spec: GiltSpec = DEFAULT_GILT): Uint8ClampedArray {
  const { size, steps, seed, streaks, alpha } = spec;
  const out = new Uint8ClampedArray(size * size * 4);
  const ramp = GILT_RAMP.map(parseHex);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const streak = tileNoise(u, v, 1, streaks, seed);
      const shimmer = tileNoise(u, v, 6, 2, seed + 313);
      let t = streak * 0.7 + shimmer * 0.3;
      // 顶边那条镜面高光：金色没这一下就不像"镀"，像刷漆
      if (y < 2) t += 0.45;
      t = Math.min(1, Math.max(0, t));

      const color = ramp[rampIndex(Math.floor(t * steps), steps, ramp.length)]!;
      const i = (y * size + x) * 4;
      out[i] = color.r;
      out[i + 1] = color.g;
      out[i + 2] = color.b;
      out[i + 3] = alpha;
    }
  }
  return out;
}

/**
 * 缺员徽章上那颗"人口头像"：8×8 像素，一个梳发髻的脸。
 * 画得再糙也要能认出是"人"，因为它旁边那个 ✕ 才有意义。
 */
export function facePixels(): Uint8ClampedArray {
  const size = 8;
  const out = new Uint8ClampedArray(size * size * 4);
  const skin = parseHex('#e8c39a');
  const hair = parseHex('#3b2412');
  const eye = parseHex('#120b06');
  const rows = [
    '..HHHH..',
    '.HHHHHH.',
    'HSSSSSSH',
    'HSESSESH',
    'HSSSSSSH',
    '.SSMMSS.',
    '..SSSS..',
    '...SS...',
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = rows[y]![x]!;
      const color = ch === 'H' ? hair : ch === 'S' ? skin : ch === 'E' ? eye : ch === 'M' ? parseHex('#a86f26') : null;
      const i = (y * size + x) * 4;
      if (!color) {
        out[i + 3] = 0;
        continue;
      }
      out[i] = color.r;
      out[i + 1] = color.g;
      out[i + 2] = color.b;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** 纯数组 → data URL。canvas 只在浏览器里有，所以这一步单独隔出来。 */
function toDataUrl(pixels: Uint8ClampedArray, size: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2d 上下文，纹理生成不了');
  // 复制一份：TS 5.7 的 ImageData 只收 ArrayBuffer 支撑的数组，
  // 而上面两个生成器返回的是宽一点的 Uint8ClampedArray。9KB 的拷贝，启动一次，无所谓。
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), size, size), 0, 0);
  return canvas.toDataURL('image/png');
}

export interface ThemeReadout {
  woodBytes: number;
  giltBytes: number;
  woodMs: number;
  giltMs: number;
  /** 放大倍率：写进 CSS，面板按 size*scale 平铺，方块边长就是 scale 像素 */
  scale: number;
}

/**
 * 生成两张纹理并挂到 CSS 变量上。CSS 里默认值是 `none`，
 * 所以这一步哪怕抛了（拿不到 2d 上下文），面板只是退成纯渐变，不会白屏。
 */
export function installTheme(
  root: HTMLElement = document.documentElement,
  wood: WoodSpec = DEFAULT_WOOD,
  gilt: GiltSpec = DEFAULT_GILT,
  scale = 2,
): ThemeReadout {
  const t0 = performance.now();
  const woodUrl = toDataUrl(woodPixels(wood), wood.size);
  const t1 = performance.now();
  const giltUrl = toDataUrl(giltPixels(gilt), gilt.size);
  const t2 = performance.now();

  root.style.setProperty('--tex-wood', `url("${woodUrl}")`);
  root.style.setProperty('--tex-gilt', `url("${giltUrl}")`);
  root.style.setProperty('--tex-face', `url("${toDataUrl(facePixels(), 8)}")`);
  root.style.setProperty('--tex-wood-tile', `${wood.size * scale}px`);
  root.style.setProperty('--tex-gilt-tile', `${gilt.size * scale}px`);

  return {
    woodBytes: woodUrl.length,
    giltBytes: giltUrl.length,
    woodMs: t1 - t0,
    giltMs: t2 - t1,
    scale,
  };
}
