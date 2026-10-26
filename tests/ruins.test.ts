/**
 * 随机碎裂的锁 —— 这是"废墟长得不一样"的唯一凭据。
 *
 * 两条必须同时成立：**同一次拆解永远同一个结果**（刷新前后不闪），
 * 而**不同楼/不同种子一定不一样**（不然每堆废墟都长一个样）。
 */

import { describe, expect, it } from 'vitest';
import { fracture, spall } from '@arena/ruins';

describe('碎裂（BSP 切块）', () => {
  it('同一个种子两次结果全等（可复现，不依赖 Math.random）', () => {
    const a = fracture(3, 3, 12345, 9);
    const b = fracture(3, 3, 12345, 9);
    expect(b).toEqual(a);
  });

  it('不同种子切出来的形状不一样', () => {
    const a = fracture(3, 3, 1, 9);
    const b = fracture(3, 3, 2, 9);
    expect(b).not.toEqual(a);
    // 比"块数不同"更强的判据：尺寸序列不一样
    expect(a.map((p) => +p.w.toFixed(3))).not.toEqual(b.map((p) => +p.w.toFixed(3)));
  });

  it('块数按要的来，且每块都有正的大小', () => {
    for (const n of [4, 9, 14]) {
      const parts = fracture(3, 3, 7, n);
      expect(parts).toHaveLength(n);
      for (const p of parts) {
        expect(p.w).toBeGreaterThan(0);
        expect(p.d).toBeGreaterThan(0);
        expect(p.h).toBeGreaterThan(0);
      }
    }
  });

  it('碎块大致留在原地：中心不跑出占地外一圈', () => {
    for (const p of fracture(3, 3, 99, 9)) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1.6);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(1.6);
    }
  });

  it('掉渣是往墙外崩的，而且比原地那几块小', () => {
    const base = fracture(3, 3, 55, 5);
    const chips = spall(3, 3, 55, 5);
    expect(chips).toHaveLength(5);
    chips.forEach((chip, i) => {
      const origin = base[i]!;
      const before = Math.hypot(origin.x, origin.z);
      const after = Math.hypot(chip.x, chip.z);
      expect(after).toBeGreaterThan(before);
      expect(chip.w).toBeLessThanOrEqual(0.34);
      expect(chip.h).toBeLessThanOrEqual(0.2);
    });
  });
});
