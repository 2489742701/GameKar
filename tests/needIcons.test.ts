/**
 * 缺配牌子的 SVG 图标（2026-11-06 用户：「房顶上缺房屋或者缺什么，都改成 SVG」）。
 *
 * 这里钉住的不是"好看"（截图才判得了），是**装配层面能被 three 吃下去**：
 * data URL 必须能原样解码回 SVG，否则 # / 中文会被浏览器当锚点或乱码，
 * 贴图加载失败时 Sprite 会变成一块白板 —— 而代码本身不会报错。
 */

import { describe, expect, it } from 'vitest';
import { NEED_ICON_SVG, needIconUrl } from '../src/arena/visuals/needIcons';

describe('缺配 SVG 图标', () => {
  it('两种图标都是完整 SVG，且都带红叉角标', () => {
    for (const kind of ['house', 'millHouse'] as const) {
      const svg = NEED_ICON_SVG[kind];
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg, `${kind} 缺红叉`).toContain('#e2503f');
      expect(svg, `${kind} 缺房屋`).toContain('M32 13');
    }
  });

  it('兵营那块比塔多一个小风车（缺磨坊 + 民居）', () => {
    expect(NEED_ICON_SVG.millHouse).toContain('rotate(90 12 12)');
    expect(NEED_ICON_SVG.house).not.toContain('rotate(90 12 12)');
  });

  it('data URL 原样可解码回 SVG，不会被 # 截断', () => {
    for (const kind of ['house', 'millHouse'] as const) {
      const url = needIconUrl(kind);
      expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
      expect(decodeURIComponent(url.split(',')[1]!)).toBe(NEED_ICON_SVG[kind]);
    }
  });
});
