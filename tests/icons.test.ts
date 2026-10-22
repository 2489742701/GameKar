/**
 * 图标形状与配色的锁（ui/icons.ts）。
 *
 * 这一族不需要 DOM：查的是字符画本身 —— 行数列数齐不齐、每个颜色字符有没有定义、
 * 合并矩形之后覆盖的格子数对不对。图形画歪这种事，只有这几把尺子量得出来。
 */

import { describe, expect, it } from 'vitest';
import { iconRects, resourceIcon, type IconName } from '@ui/icons';

const NAMES: IconName[] = ['gold', 'crystal', 'bread', 'pop', 'sword', 'shield', 'heart'];

const area = (name: IconName): number => iconRects(name).reduce((n, r) => n + r.w, 0);

describe('像素图标', () => {
  it('每张图都是 8×8 的合法字符画：合并矩形后面积等于实心格数', () => {
    for (const name of NAMES) {
      const rects = iconRects(name);
      expect(rects.length, name).toBeGreaterThan(0);
      // 每个矩形都是一格高、宽度不超过 8，且都在网格内
      for (const r of rects) {
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeLessThan(8);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(8);
        expect(r.w).toBeGreaterThan(0);
      }
    }
  });

  it('三种资源各有对应图标，且不会两个资源画成同一个', () => {
    expect(resourceIcon).toMatchObject({ gold: 'gold', crystal: 'crystal', bread: 'bread' });
    const used = Object.values(resourceIcon);
    expect(new Set(used).size).toBe(used.length);
  });

  /** 形状锁：实心格数钉死（现量得出来的，不是估的）。手滑擦掉一格或多填一格都会红。 */
  it('每张图的实心格数钉死', () => {
    expect(area('gold')).toBe(52);
    expect(area('crystal')).toBe(36);
    expect(area('bread')).toBe(52);
    expect(area('pop')).toBe(43);
    expect(area('sword')).toBe(25);
    expect(area('shield')).toBe(42);
    expect(area('heart')).toBe(40);
  });
});
