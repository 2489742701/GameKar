/**
 * 旗帜花色系统的锁（2026-11-06 P-045）。
 *
 * 纯逻辑层：类型 / 预设 / 存取档 / 敌方解析 / 颜色换算。
 * 画布相关的（bannerClothCanvas / drawEmblem）在 node 里没有 document，
 * 靠实机截图验收（见流水账 P-045 的探针读数）。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLUE,
  DEFAULT_RED,
  ENEMY_PRESETS,
  EMBLEMS,
  SCHEMES,
  DEFAULT_SETTINGS,
  hexToInt,
  loadSettings,
  resolveEnemyBanner,
  saveSettings,
  type Banner,
} from '@arena/banner';
import { setSideBanners, sideColor, sideBanner } from '@arena/theme';

describe('花色：默认与预设（P-045）', () => {
  it('默认蓝旗是蓝系（主色蓝通道显著更高），与旧 SIDE_COLOR.blue 同源', () => {
    const n = hexToInt(DEFAULT_BLUE.primary);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    expect(b).toBeGreaterThan(r + 25);
    expect(b).toBeGreaterThan(g + 15);
    expect(DEFAULT_BLUE.primary).toBe('#3f7fe0');
  });

  it('敌方预设池都不和默认蓝旗同色（敌我永远分得清）', () => {
    expect(ENEMY_PRESETS.length).toBeGreaterThanOrEqual(3);
    const blue = hexToInt(DEFAULT_BLUE.primary);
    for (const p of ENEMY_PRESETS) {
      expect(hexToInt(p.primary), `${p.primary} 不该和默认蓝旗同色`).not.toBe(blue);
    }
    expect(ENEMY_PRESETS).toContainEqual(DEFAULT_RED);
  });
});

describe('花色：存取档（localStorage 缺失/损坏都兜底）', () => {
  it('没有 localStorage（node 环境）→ 默认值', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('损坏的存档 → 默认值（不抛异常）', () => {
    const fake = { getItem: () => '{oops', setItem: () => {} };
    const orig = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    try {
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('round-trip：save 再 load 读回同一份', () => {
    const player: Banner = { primary: '#205020', secondary: '#a0e0a0', emblem: 'moon', emblemColor: '#ffffff' };
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const orig = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    try {
      saveSettings({ player, enemy: 'random' });
      expect(loadSettings()).toEqual({ player, enemy: 'random' });
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});

describe('敌方花色解析', () => {
  it('red 模式 = 固定红旗（任何 seed 都一样）', () => {
    for (const seed of [1, 7, 20261027]) {
      expect(resolveEnemyBanner(DEFAULT_SETTINGS, seed)).toEqual(DEFAULT_RED);
    }
  });

  it('random 模式：同 seed 同花色（一局内稳定、可复现），且必出自预设池', () => {
    const s: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS, enemy: 'random' };
    for (let seed = 0; seed < 24; seed++) {
      const a = resolveEnemyBanner(s, seed);
      const b = resolveEnemyBanner(s, seed);
      expect(a).toBe(b);
      expect(ENEMY_PRESETS).toContainEqual(a);
    }
  });
});

describe('注入链路：setSideBanners 后 sideColor/sideBanner 跟着花色走', () => {
  it('sideColor = 花色主色的 int；sideBanner 原样返回', () => {
    const green: Banner = { primary: '#2e8f5b', secondary: '#9fd8b8', emblem: 'moon', emblemColor: '#ffffff' };
    const purple: Banner = { primary: '#8a4fd0', secondary: '#d0b0ff', emblem: 'sword', emblemColor: '#ffffff' };
    setSideBanners({ blue: green, red: purple });
    expect(sideColor('blue')).toBe(hexToInt('#2e8f5b'));
    expect(sideColor('red')).toBe(hexToInt('#8a4fd0'));
    expect(sideBanner('blue')).toEqual(green);
    expect(sideBanner('red')).toEqual(purple);
    // 还原默认（别的测试不背这口锅）
    setSideBanners({ blue: DEFAULT_BLUE, red: DEFAULT_RED });
    expect(sideColor('blue')).toBe(hexToInt(DEFAULT_BLUE.primary));
  });

  it('hexToInt：合法十六进制照转，写坏按黑处理（不抛）', () => {
    expect(hexToInt('#ff0000')).toBe(0xff0000);
    expect(hexToInt('3f7fe0')).toBe(0x3f7fe0);
    expect(hexToInt('oops')).toBe(0x000000);
  });
});

describe('P-046：更多花色 + 预设配色', () => {
  it('徽记扩到 12 款，id 全唯一', () => {
    expect(EMBLEMS.length).toBe(12);
    expect(new Set(EMBLEMS.map((e) => e.id)).size).toBe(EMBLEMS.length);
  });

  it('预设配色 ≥ 6 套，三色全部是合法十六进制', () => {
    expect(SCHEMES.length).toBeGreaterThanOrEqual(6);
    for (const s of SCHEMES) {
      for (const hex of [s.primary, s.secondary, s.emblemColor]) {
        expect(hex, `${s.name} 的 ${hex}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it('反证：预设里不许有完全相同的三色套（不然"预选"是重复的）', () => {
    const keys = SCHEMES.map((s) => `${s.primary}|${s.secondary}|${s.emblemColor}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
