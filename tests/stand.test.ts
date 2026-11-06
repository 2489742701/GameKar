/**
 * 看台的"整段随镜头显隐"判据。
 *
 * 用户 2026-11-06 的澄清：「玩家在左边，左边的看台就消失；玩家面对右侧，
 * 右侧的看台消失、左侧重新显示」—— 藏的是**离镜头最近的那一整段**，
 * 不是某个面，也不是固定藏某一段。
 */

import { describe, expect, it } from 'vitest';
import { nearestSegment } from '../src/arena/stand';

describe('看台按相机方位整段显隐', () => {
  it('yaw=0 在 +z：近侧本来就没建看台，三段都显示', () => {
    expect(nearestSegment(0)).toBe('front');
    expect(nearestSegment(360)).toBe('front');
    expect(nearestSegment(-10)).toBe('front');
  });

  it('yaw=90 在 +x：右侧看台藏、左侧恢复', () => {
    expect(nearestSegment(90)).toBe('right');
    expect(nearestSegment(60)).toBe('right');
    expect(nearestSegment(134)).toBe('right');
  });

  it('yaw=180 在 -z：后看台藏', () => {
    expect(nearestSegment(180)).toBe('back');
    expect(nearestSegment(225)).not.toBe('back'); // 225 已经转进左侧象限
  });

  it('yaw=270 在 -x：左侧看台藏（用户举的第一个例子）', () => {
    expect(nearestSegment(270)).toBe('left');
    expect(nearestSegment(-90)).toBe('left');
  });

  it('四个象限各只藏一段，边界不重叠', () => {
    const seen = new Set<string>();
    for (let a = 0; a < 360; a += 15) seen.add(nearestSegment(a));
    expect([...seen].sort()).toEqual(['back', 'front', 'left', 'right']);
  });
});
