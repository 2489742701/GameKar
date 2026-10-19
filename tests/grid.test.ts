import { describe, expect, it } from 'vitest';
import {
  DIAGONAL,
  cellToWorld,
  chebyshev,
  footprintCenter,
  footprintRect,
  inBounds,
  neighbors,
  pos,
  worldToCell,
} from '@engine/math/Grid';

describe('网格数学', () => {
  it('格心与世界坐标可以往返，不漂移半格', () => {
    for (const p of [pos(0, 0), pos(7, 3), pos(45, 45)]) {
      const w = cellToWorld(p);
      expect(worldToCell(w.x, w.z)).toEqual(p);
    }
  });

  it('占地矩形按左上角展开，2x3 交出 6 格', () => {
    const cells = footprintRect({ origin: pos(10, 20), cols: 2, rows: 3 });
    expect(cells).toHaveLength(6);
    expect(cells[0]).toEqual(pos(10, 20));
    expect(cells.at(-1)).toEqual(pos(11, 22));
  });

  it('多格建筑锚点是占地中心，不是左上角', () => {
    const c = footprintCenter({ origin: pos(10, 20), cols: 2, rows: 2 });
    expect(c).toEqual({ x: 11, z: 21 });
  });

  it('越界格一律 false，邻接表把越界的剔掉', () => {
    const size = { cols: 46, rows: 46 };
    expect(inBounds(pos(-1, 0), size)).toBe(false);
    expect(inBounds(pos(46, 0), size)).toBe(false);
    expect(neighbors(pos(0, 0), size).length).toBe(3);
    expect(DIAGONAL).toHaveLength(8);
  });

  it('切比雪夫距离把斜走算作一步', () => {
    expect(chebyshev(pos(0, 0), pos(3, 1))).toBe(3);
    expect(chebyshev(pos(0, 0), pos(2, 2))).toBe(2);
  });
});
