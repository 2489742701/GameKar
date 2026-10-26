/**
 * 浮尘的锁：同种子同分布、漂多久都不出场地。
 * 这两条都是"看着没问题、跑久了才炸"的类型（随机源不可复现 / 坐标溢出）。
 */

import { describe, expect, it } from 'vitest';
import { AmbientDust } from '../src/arena/ambient';

describe('战场浮尘', () => {
  it('同种子的初始分布完全一致（没有用 Math.random）', () => {
    const a = new AmbientDust(42, 20, 60, 7);
    const b = new AmbientDust(42, 20, 60, 7);
    const pa = Array.from(a.points.geometry.getAttribute('position').array as Float32Array);
    const pb = Array.from(b.points.geometry.getAttribute('position').array as Float32Array);
    expect(pa).toEqual(pb);
  });

  it('漂 100 秒也不出场地（到边绕回，不是飞走）', () => {
    const dust = new AmbientDust(42, 20, 60, 9);
    for (let i = 0; i < 500; i++) dust.update(0.2);
    const p = dust.points.geometry.getAttribute('position').array as Float32Array;
    expect(p.length).toBe(60 * 3);
    for (let i = 0; i < p.length; i += 3) {
      expect(p[i]!, 'x').toBeGreaterThanOrEqual(0);
      expect(p[i]!, 'x').toBeLessThanOrEqual(42);
      expect(p[i + 1]!, 'y').toBeGreaterThan(0);
      expect(p[i + 2]!, 'z').toBeGreaterThanOrEqual(0);
      expect(p[i + 2]!, 'z').toBeLessThanOrEqual(20);
    }
  });
});
