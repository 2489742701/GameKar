/**
 * AI 落点分层的锁（2026-11-07 用户："AI 可以更智能一点，比如说它放建筑时，
 * 经济类建筑放后面，防御类建筑放前面"）。
 *
 * 两层分开验：
 *  ① `placementBand()` 是纯策略，经济带和防御带不许重叠；
 *  ② **端到端**：直接调 `ArenaWorld.randomSpot()` 采样 60 次，
 *     蓝方经济的平均 col 必须明显小于防御，红方反过来。
 *     只测纯函数不够 —— 阵营方向翻错了纯函数照样全绿。
 */
import { describe, expect, it } from 'vitest';
import { ArenaWorld } from '@arena/ArenaWorld';
import { placementBand } from '@arena/ai';
import { cardById } from '@arena/config';
import type { Side } from '@arena/ArenaWorld';

describe('落点纵深带（纯策略）', () => {
  const econ = ['house', 'mill', 'gearFactory'] as const;
  const defense = ['arrowTower', 'cannonTower'] as const;

  it('经济 / 被动科技全在后段，防御塔全在前段，两段不重叠', () => {
    for (const id of econ) {
      expect(placementBand(cardById(id)).hi, `${id} 不该伸到前线`).toBeLessThanOrEqual(0.4);
    }
    for (const id of defense) {
      expect(placementBand(cardById(id)).lo, `${id} 不该缩在后方`).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('兵营居中偏前、军队压前线', () => {
    const barracks = placementBand(cardById('barracks'));
    expect(barracks.lo).toBeGreaterThan(0.4);
    expect(barracks.hi).toBeGreaterThan(0.8);
    expect(placementBand(cardById('militia')).lo).toBeGreaterThanOrEqual(0.65);
  });

  it('所有带都合法（0≤lo≤hi≤1）', () => {
    for (const card of ['house', 'mill', 'gearFactory', 'arrowTower', 'cannonTower', 'barracks', 'militia']) {
      const b = placementBand(cardById(card));
      expect(b.lo).toBeGreaterThanOrEqual(0);
      expect(b.lo).toBeLessThanOrEqual(b.hi);
      expect(b.hi).toBeLessThanOrEqual(1);
    }
  });
});

/** 在空场地上反复取落点（不真正放楼，所以不会互相挤掉）。 */
function sampleMean(side: Side, id: string, times = 60): { mean: number; hits: number } {
  const w = new ArenaWorld({ seed: 91 });
  let sum = 0;
  let hits = 0;
  for (let i = 0; i < times; i++) {
    const cell = w['randomSpot'](side, cardById(id));
    if (cell) {
      sum += cell.col;
      hits++;
    }
  }
  return { mean: sum / Math.max(1, hits), hits };
}

describe('端到端：真的按阵营分层落点', () => {
  it('蓝方：磨坊 / 民居明显比塔更靠自家（col 更小）', () => {
    for (const id of ['mill', 'house']) {
      const econ = sampleMean('blue', id);
      const tower = sampleMean('blue', 'arrowTower');
      expect(econ.hits, `${id} 不该找不到落点`).toBeGreaterThan(50);
      expect(tower.hits).toBeGreaterThan(50);
      expect(econ.mean + 5, `${id} 该缩在后方`).toBeLessThan(tower.mean);
    }
  });

  it('红方方向相反：塔的 col 更小（更靠中场）', () => {
    const econ = sampleMean('red', 'mill');
    const tower = sampleMean('red', 'cannonTower');
    expect(econ.hits).toBeGreaterThan(50);
    expect(tower.hits).toBeGreaterThan(50);
    expect(tower.mean + 5).toBeLessThan(econ.mean);
  });

  it('策略是偏好不是硬限制：空场地永远找得到落点', () => {
    for (const side of ['blue', 'red'] as const) {
      for (const id of ['house', 'mill', 'gearFactory', 'arrowTower', 'barracks', 'militia']) {
        const r = sampleMean(side, id, 10);
        expect(r.hits, `${side} ${id} 落点`).toBe(10);
      }
    }
  });
});
