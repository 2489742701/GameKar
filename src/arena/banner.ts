/**
 * **旗帜花色系统**（2026-11-06 用户："用户可以自己定义自己的旗帜——花色、图案、
 * 旗。像素小人也严格按照花色来处理，房顶的颜色也可以设计。默认给一个蓝色的旗，
 * 敌方可以是红色的，也可以是随机颜色。"）
 *
 * 一个 Banner = { 主色, 次色, 图案, 图案色 }，全场只有一份事实：
 * - **主色**：旗帜布面、建筑房顶（roofOf/ridgeOf 的 accent）、像素小人的 suit；
 * - **次色**：小人的镶边（more）、旗面边框；
 * - **图案**：旗面上的家族徽记（剪影），图案色单独可调；
 * - 落点：`theme.setSideBanners()` 全局生效一次，之后 sideColor()/sideBanner() 都读它。
 *
 * 持久化走 localStorage（`gamekar.banner`）；敌方「随机」模式按 seed 从预设里挑，
 * 同一局内稳定、跨局可复现。
 */

export type EmblemId =
  | 'star' | 'moon' | 'sword' | 'shield' | 'diamond' | 'cross'
  | 'sun' | 'bolt' | 'triangle' | 'ring' | 'crown' | 'mountain';

export interface Banner {
  /** 主色：旗面 / 房顶 / 小人主衣色 */
  primary: string;
  /** 次色：小人镶边 / 旗缘 */
  secondary: string;
  /** 旗面徽记 */
  emblem: EmblemId;
  /** 徽记颜色 */
  emblemColor: string;
}

/** 默认蓝旗（用户："默认给用户准备一个蓝色的旗"）—— 与旧 SIDE_COLOR.blue 同源。 */
export const DEFAULT_BLUE: Banner = {
  primary: '#3f7fe0',
  secondary: '#8db6ff',
  emblem: 'star',
  emblemColor: '#ffe9a8',
};

/** 默认红旗（敌方的老颜色）。 */
export const DEFAULT_RED: Banner = {
  primary: '#d9453c',
  secondary: '#ff9c93',
  emblem: 'sword',
  emblemColor: '#ffe0c8',
};

/** 徽记一览：id + 中文名 + 画法（归一化 0..1 坐标里的剪影）。 */
export const EMBLEMS: { id: EmblemId; name: string }[] = [
  { id: 'star', name: '星' },
  { id: 'moon', name: '月' },
  { id: 'sword', name: '剑' },
  { id: 'shield', name: '盾' },
  { id: 'diamond', name: '菱' },
  { id: 'cross', name: '十字' },
  // 2026-11-06 用户："花色还是太少了，可以增加一些花色"
  { id: 'sun', name: '日' },
  { id: 'bolt', name: '电' },
  { id: 'triangle', name: '峰' },
  { id: 'ring', name: '环' },
  { id: 'crown', name: '冠' },
  { id: 'mountain', name: '山' },
];

/**
 * 在画布上画一面旗：主色布 + 次色边框 + 居中徽记。
 * `document` 不存在（node 测试 / SSR）时返回 null —— 调用方自行退化成纯色布。
 */
export function bannerClothCanvas(banner: Banner, w = 96, h = 64): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = banner.primary;
  ctx.fillRect(0, 0, w, h);
  // 次色边框：4 格宽的旗缘，远远看得出"这是谁家的旗"
  ctx.fillStyle = banner.secondary;
  ctx.fillRect(0, 0, w, 4);
  ctx.fillRect(0, h - 4, w, 4);
  ctx.fillRect(0, 0, 4, h);
  ctx.fillRect(w - 4, 0, 4, h);
  // 徽记：居中，约占布面 46%
  const size = Math.min(w, h) * 0.46;
  ctx.save();
  ctx.translate((w - size) / 2, (h - size) / 2);
  ctx.scale(size, size);
  ctx.fillStyle = banner.emblemColor;
  drawEmblem(ctx, banner.emblem);
  ctx.restore();
  return canvas;
}

/** 在已 translate/scale 好的（0..1 单位方形）上下文里画徽记剪影。 */
export function drawEmblem(ctx: CanvasRenderingContext2D, emblem: EmblemId): void {
  ctx.beginPath();
  switch (emblem) {
    case 'star': {
      // 五角星：外径 0.5 / 内径 0.21
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.5 : 0.21;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = 0.5 + Math.cos(a) * r;
        const y = 0.5 + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    }
    case 'moon': {
      // 月牙：大圆减去偏移圆（用 evenodd 挖）
      ctx.arc(0.5, 0.5, 0.42, 0, Math.PI * 2);
      ctx.moveTo(0.72, 0.5);
      ctx.arc(0.72, 0.5, 0.36, 0, Math.PI * 2);
      ctx.fill('evenodd');
      return;
    }
    case 'sword': {
      // 竖剑：刃 + 十字护手 + 柄
      ctx.rect(0.44, 0.02, 0.12, 0.6);
      ctx.rect(0.22, 0.6, 0.56, 0.1);
      ctx.rect(0.44, 0.7, 0.12, 0.18);
      ctx.rect(0.38, 0.86, 0.24, 0.08);
      break;
    }
    case 'shield': {
      // 盾：上宽下尖
      ctx.moveTo(0.14, 0.12);
      ctx.lineTo(0.86, 0.12);
      ctx.lineTo(0.86, 0.5);
      ctx.quadraticCurveTo(0.86, 0.82, 0.5, 0.96);
      ctx.quadraticCurveTo(0.14, 0.82, 0.14, 0.5);
      ctx.closePath();
      break;
    }
    case 'diamond': {
      ctx.moveTo(0.5, 0.04);
      ctx.lineTo(0.92, 0.5);
      ctx.lineTo(0.5, 0.96);
      ctx.lineTo(0.08, 0.5);
      ctx.closePath();
      break;
    }
    case 'cross': {
      ctx.rect(0.38, 0.06, 0.24, 0.88);
      ctx.rect(0.12, 0.32, 0.76, 0.24);
      break;
    }
    case 'sun': {
      // 日：中心圆 + 8 道射线（射线用细长矩形，绕中心转）
      ctx.arc(0.5, 0.5, 0.22, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.save();
        ctx.translate(0.5, 0.5);
        ctx.rotate(a);
        ctx.fillRect(-0.045, -0.48, 0.09, 0.2);
        ctx.restore();
      }
      return;
    }
    case 'bolt': {
      // 闪电
      ctx.moveTo(0.6, 0.02);
      ctx.lineTo(0.2, 0.54);
      ctx.lineTo(0.46, 0.54);
      ctx.lineTo(0.36, 0.98);
      ctx.lineTo(0.8, 0.4);
      ctx.lineTo(0.52, 0.4);
      ctx.closePath();
      break;
    }
    case 'triangle': {
      ctx.moveTo(0.5, 0.06);
      ctx.lineTo(0.94, 0.9);
      ctx.lineTo(0.06, 0.9);
      ctx.closePath();
      break;
    }
    case 'ring': {
      // 环：外圆减内圆（evenodd 挖）
      ctx.arc(0.5, 0.5, 0.44, 0, Math.PI * 2);
      ctx.moveTo(0.74, 0.5);
      ctx.arc(0.5, 0.5, 0.24, 0, Math.PI * 2);
      ctx.fill('evenodd');
      return;
    }
    case 'crown': {
      // 王冠：三尖 + 底座
      ctx.moveTo(0.1, 0.78);
      ctx.lineTo(0.1, 0.3);
      ctx.lineTo(0.32, 0.52);
      ctx.lineTo(0.5, 0.16);
      ctx.lineTo(0.68, 0.52);
      ctx.lineTo(0.9, 0.3);
      ctx.lineTo(0.9, 0.78);
      ctx.closePath();
      break;
    }
    case 'mountain': {
      // 双峰山
      ctx.moveTo(0.04, 0.86);
      ctx.lineTo(0.38, 0.22);
      ctx.lineTo(0.58, 0.56);
      ctx.lineTo(0.72, 0.36);
      ctx.lineTo(0.96, 0.86);
      ctx.closePath();
      break;
    }
  }
  ctx.fill();
}

/**
 * **预设配色**（2026-11-06 用户："颜色除了自定义，也给用户准备几个不错的颜色
 *  预选"）：三色成套的方案卡，点一下整套套用（徽记不动）。
 *  色值都挑过：布面在深色战场上一眼认得出，徽记色足够亮。
 */
export interface ColorScheme {
  name: string;
  primary: string;
  secondary: string;
  emblemColor: string;
}

export const SCHEMES: ColorScheme[] = [
  { name: '蔚蓝', primary: '#3f7fe0', secondary: '#8db6ff', emblemColor: '#ffe9a8' },
  { name: '绯红', primary: '#d9453c', secondary: '#ff9c93', emblemColor: '#ffe0c8' },
  { name: '翠绿', primary: '#2e8f5b', secondary: '#9fd8b8', emblemColor: '#ffffff' },
  { name: '紫晶', primary: '#8a4fd0', secondary: '#d0b0ff', emblemColor: '#f2e6ff' },
  { name: '鎏金', primary: '#c07f1f', secondary: '#ffd98a', emblemColor: '#fff3d0' },
  { name: '冰霜', primary: '#4fa8c9', secondary: '#bfe8f5', emblemColor: '#ffffff' },
  { name: '玄墨', primary: '#33363f', secondary: '#9aa0ad', emblemColor: '#e8e8ee' },
  { name: '落霞', primary: '#c2554f', secondary: '#ffb9a0', emblemColor: '#ffe9a8' },
];

/** 敌方预设花色池：都不是蓝系（别和玩家的默认蓝旗撞脸）。 */
export const ENEMY_PRESETS: Banner[] = [
  DEFAULT_RED,
  { primary: '#8a4fd0', secondary: '#d0b0ff', emblem: 'moon', emblemColor: '#f2e6ff' },
  { primary: '#c07f1f', secondary: '#ffd98a', emblem: 'shield', emblemColor: '#fff3d0' },
  { primary: '#2e8f5b', secondary: '#9fd8b8', emblem: 'diamond', emblemColor: '#e8fff2' },
  { primary: '#33363f', secondary: '#9aa0ad', emblem: 'cross', emblemColor: '#e8e8ee' },
];

/** hex → 0xRRGGBB（theme 的颜色都是 int；写错十六进制按黑处理，别让页面崩）。 */
export function hexToInt(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 0x000000;
  return Number.parseInt(m[1]!, 16);
}

const STORAGE_KEY = 'gamekar.banner';

export interface BannerSettings {
  /** 玩家（蓝方槽位）的花色 */
  player: Banner;
  /** 敌方模式：固定红旗 / 按局随机 */
  enemy: 'red' | 'random';
}

export const DEFAULT_SETTINGS: BannerSettings = { player: DEFAULT_BLUE, enemy: 'red' };

/** 读回本地花色（node / 隐私模式没有 localStorage → 默认值）。损坏的存档按默认处理。 */
export function loadSettings(): BannerSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<BannerSettings>;
    const ok = (b: Partial<Banner> | undefined): b is Banner =>
      !!b && typeof b.primary === 'string' && typeof b.secondary === 'string' && typeof b.emblem === 'string' && typeof b.emblemColor === 'string';
    if (!ok(parsed.player)) return { ...DEFAULT_SETTINGS };
    return {
      player: parsed.player,
      enemy: parsed.enemy === 'random' ? 'random' : 'red',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: BannerSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式写不进去就算了，这局先用手调的
  }
}

/**
 * `?banner=` URL 参数 → 花色（测试 / 分享链接通道，和 ?play/?auto/?seed 同一模式）。
 * 接受 `{"player":{...},"enemy":"red|random"}`，缺的字段回落本地存档；
 * 解析不了返回 null（调用方退回 loadSettings）。只覆盖本局，**不写** localStorage。
 */
export function settingsFromParam(raw: string, fallback: BannerSettings): BannerSettings {
  try {
    const parsed = JSON.parse(raw) as { player?: Partial<Banner>; enemy?: string };
    const b = parsed.player;
    const ok =
      !!b &&
      typeof b.primary === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.primary) &&
      typeof b.secondary === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.secondary) &&
      typeof b.emblemColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.emblemColor) &&
      typeof b.emblem === 'string' && EMBLEMS.some((e) => e.id === b.emblem);
    if (!ok) return fallback;
    return {
      player: b as Banner,
      enemy: parsed.enemy === 'random' ? 'random' : parsed.enemy === 'red' ? 'red' : fallback.enemy,
    };
  } catch {
    return fallback;
  }
}

/**
 * 敌方花色解析：red = 固定红旗；random = 按 seed 从预设池挑（同 seed 同花色，
 * 一局内稳定、复盘可复现）。玩家自定义的花色不参与随机池，敌我永远分得清。
 */
export function resolveEnemyBanner(settings: BannerSettings, seed: number): Banner {
  if (settings.enemy === 'red') return DEFAULT_RED;
  return ENEMY_PRESETS[Math.abs(seed) % ENEMY_PRESETS.length]!;
}
