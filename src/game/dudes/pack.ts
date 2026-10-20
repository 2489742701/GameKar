/**
 * 小人素材包 —— 把 pack.json 与三张表的实际尺寸读成一个可查的对象。
 *
 * 关键决定：头/脸/体型的**数量上限一律由图片尺寸算出来**，不写死。
 * 上游那份移植包只有 1 个体型（base.png 高 24 = 1 行），而原版把体型按行分成
 * human 0-15 / animal 16-32 / monster 33-53 ……将来换大包时代码不用改。
 */

import { KNOWN_ANIMS } from './anims';

export type PaletteRole = 'eyes' | 'body' | 'item' | 'suit' | 'more';
export type SourceRole =
  | 'outline'
  | 'eyes'
  | 'skin'
  | 'skin2'
  | 'more'
  | 'more2'
  | 'item'
  | 'item2'
  | 'suit'
  | 'suit2';

export type Rgb = readonly [number, number, number];

/** 渲染一帧要用的颜色：5 组调色板的当前色 + 描边色。 */
export interface ColorSet {
  outline: Rgb;
  palette: Record<PaletteRole, Rgb>;
}

export interface PackImages {
  base: HTMLImageElement;
  heads: HTMLImageElement;
  faces: HTMLImageElement;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** 一张表的格子数：横着是变体或帧，竖着是体型行。 */
export interface PackGrid {
  base: ImageSize;
  heads: ImageSize;
  faces: ImageSize;
}

export interface DudePack {
  /** 单格像素，素材是 16x24 */
  readonly w: number;
  readonly h: number;
  readonly version: number;
  readonly outline: Rgb;
  /** 素材里"这块像素该被换成什么"的源色 */
  readonly from: Record<SourceRole, Rgb>;
  /** 阴影变体的暗化系数（每个部位各一条，本包四个都是 0.5） */
  readonly shadow: Record<PaletteRole, number>;
  readonly palettes: Record<PaletteRole, readonly string[]>;
  readonly grid: PackGrid;
  readonly maxima: { base: number; head: number; face: number };
  /** base 表横向一共多少格 —— 动画列号不能越过去 */
  readonly frameCols: number;
  /** 素材带进来的动画名（本包 121 个），用来核对帧表没写漏 */
  readonly anims: readonly string[];
  /** 头/脸逐帧的上下偏移，素材自己带的"浮动" */
  offsetY(part: 'head' | 'face', anim: string, frame: number): number;
  images: PackImages | null;
}

/**
 * 换色规则表。**顺序就是语义**：源色之间只差一两个通道
 * （eyes 纯红 vs item 品红只差 B），命中第一条就走人，所以顺序错了会互相吞色。
 */
export const SUBSTITUTIONS: ReadonlyArray<{
  source: SourceRole;
  palette: PaletteRole | null;
  shadowed: boolean;
}> = [
  { source: 'outline', palette: null, shadowed: false },
  { source: 'eyes', palette: 'eyes', shadowed: false },
  { source: 'skin', palette: 'body', shadowed: false },
  { source: 'skin2', palette: 'body', shadowed: true },
  { source: 'more', palette: 'more', shadowed: false },
  { source: 'more2', palette: 'more', shadowed: true },
  { source: 'item', palette: 'item', shadowed: false },
  { source: 'item2', palette: 'item', shadowed: true },
  { source: 'suit', palette: 'suit', shadowed: false },
  { source: 'suit2', palette: 'suit', shadowed: true },
];

const asRgb = (v: unknown, label: string): Rgb => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number')) {
    throw new Error(`素材包字段 ${label} 不是 [r,g,b]`);
  }
  return [v[0] as number, v[1] as number, v[2] as number];
};

const count = (size: ImageSize, cell: number): number => Math.floor(size.width / cell);

/**
 * 纯函数版加载：把 json 与三张表的尺寸拼成 DudePack。
 * 拆成纯函数是为了能在 node 里直接断言（解码 PNG 需要浏览器，那部分留给 loadPack）。
 */
export function parsePack(raw: unknown, grid: PackGrid): DudePack {
  const conf = raw as Record<string, unknown>;
  const w = Number(conf.w);
  const h = Number(conf.h);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`素材包 w/h 不合法：${conf.w} × ${conf.h}`);
  }

  const fromRaw = conf.fromColors as Record<string, unknown>;
  const from = {} as Record<SourceRole, Rgb>;
  for (const role of Object.keys(fromRaw) as SourceRole[]) from[role] = asRgb(fromRaw[role], `fromColors.${role}`);

  const palsRaw = conf.pals as Record<string, unknown>;
  const palettes = {} as Record<PaletteRole, readonly string[]>;
  for (const role of ['eyes', 'body', 'item', 'suit', 'more'] as PaletteRole[]) {
    const list = palsRaw?.[role];
    if (!Array.isArray(list) || list.length === 0) throw new Error(`素材包调色板 ${role} 缺失或为空`);
    palettes[role] = list as string[];
  }

  const modOf = (role: PaletteRole): number => {
    const key = `${role}ShadowMod`;
    const v = conf[key];
    return typeof v === 'number' ? v : 0.5;
  };

  const parts = conf.parts as Record<string, Record<string, number[]>>;

  // 尺寸对不上就是"拿错包 / 换了图没改 json"，宁可此刻炸掉，也别等到画面上出现半张脸
  for (const [name, size] of Object.entries(grid)) {
    if (size.width % w !== 0 || size.height % h !== 0) {
      throw new Error(`${name} 表 ${size.width}×${size.height} 不能按 ${w}×${h} 整格切开`);
    }
  }

  const frameCols = count(grid.base, w);

  // 动画列号越界是"以后换大包"最容易出现的断裂，加载时就挡住
  for (const anim of Object.values(KNOWN_ANIMS)) {
    if (anim.col + anim.frames > frameCols) {
      throw new Error(`动画 ${anim.key} 需要到第 ${anim.col + anim.frames} 列，本包只有 ${frameCols} 列`);
    }
  }

  return {
    w,
    h,
    version: Number(conf.version ?? 0),
    outline: asRgb(conf.outlineColor, 'outlineColor'),
    from,
    shadow: {
      eyes: modOf('eyes'),
      body: modOf('body'),
      item: modOf('item'),
      suit: modOf('suit'),
      more: modOf('more'),
    },
    palettes,
    grid,
    maxima: {
      base: Math.floor(grid.base.height / h) - 1,
      head: count(grid.heads, w) - 1,
      face: count(grid.faces, w) - 1,
    },
    frameCols,
    anims: Object.keys(parts?.head ?? {}),
    offsetY(part, anim, frame) {
      return parts?.[part]?.[anim]?.[frame] ?? 0;
    },
    images: null,
  };
}

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`小人贴图加载失败：${url}`));
    img.src = url;
  });

/** 浏览器侧加载：取 json + 解三张表，然后交给纯函数 parsePack。 */
export async function loadPack(baseUrl = '/assets/dudes'): Promise<DudePack> {
  const res = await fetch(`${baseUrl}/pack.json`);
  if (!res.ok) throw new Error(`读不到 ${baseUrl}/pack.json（${res.status}）`);
  const raw = await res.json();

  const [base, heads, faces] = await Promise.all([
    loadImage(`${baseUrl}/base.png`),
    loadImage(`${baseUrl}/heads.png`),
    loadImage(`${baseUrl}/faces.png`),
  ]);

  const pack = parsePack(raw, {
    base: { width: base.naturalWidth, height: base.naturalHeight },
    heads: { width: heads.naturalWidth, height: heads.naturalHeight },
    faces: { width: faces.naturalWidth, height: faces.naturalHeight },
  });
  pack.images = { base, heads, faces };
  return pack;
}

/** 把 "#rrggbb" 解成三元组；调色板与描边都从这里取值。 */
export const hexToRgb = (hex: string): Rgb => {
  const v = hex.replace('#', '');
  const n = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const int = Number.parseInt(n, 16);
  if (Number.isNaN(int)) throw new Error(`不是十六进制颜色：${hex}`);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};
