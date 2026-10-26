/**
 * 小人寻路的锁。
 *
 * 这层最容易写出"看起来对"的实现：直线插值也能走完全程，只是从墙里穿过去。
 * 所以每条都拿**几何事实**断言：绕路的长度必须比直线长、必须绕过那堵墙、必须不斜穿墙角。
 */

import { describe, expect, it } from 'vitest';
import { pos, type GridPos } from '@engine/math/Grid';
import { findPath, pathLength, pointAt } from '@game/dudes/walk';

const SIZE = { cols: 12, rows: 12 };

const open = () => false;
const walls = (...cells: GridPos[]) => {
  const set = new Set(cells.map((c) => `${c.col},${c.row}`));
  return (c: GridPos) => set.has(`${c.col},${c.row}`);
};

describe('小人寻路', () => {
  it('空地上是一条直路，长度等于两端格心的距离', () => {
    const path = findPath(SIZE, pos(0, 0), pos(0, 6), open)!;
    expect(path).not.toBeNull();
    expect(path[0]).toEqual(pos(0, 0));
    expect(path[path.length - 1]).toEqual(pos(0, 6));
    expect(path.length).toBe(7); // 6 步直走 = 7 个点
  });

  it('中间有墙会绕过去，而且总长比直线长', () => {
    // 在 col=3 上竖一堵墙，只留 row=0 的缺口
    const wall: GridPos[] = [];
    for (let row = 1; row < 10; row++) wall.push(pos(3, row));
    const blocked = walls(...wall);

    const straight = Math.hypot(6 - 1, 5 - 5);
    const path = findPath(SIZE, pos(1, 5), pos(6, 5), blocked)!;
    expect(path).not.toBeNull();

    // 一个格子都没踩到墙上
    for (const c of path) expect(blocked(c)).toBe(false);
    const len = pathLength(path.map((c) => ({ x: c.col + 0.5, z: c.row + 0.5 })));
    expect(len).toBeGreaterThan(straight + 2);
  });

  it('不斜穿墙角：斜边中间被堵就只能绕', () => {
    // (1,1) 堵住，(0,0)→(2,2) 那条斜线得绕开它
    const blocked = walls(pos(1, 1));
    const path = findPath(SIZE, pos(0, 0), pos(2, 2), blocked)!;
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(3); // 直着斜穿只要 3 个点
    for (const c of path) expect(blocked(c)).toBe(false);
  });

  it('走不通就返回 null，不偷偷兜底', () => {
    // 一整排墙把上下隔断
    const blocked = walls(pos(0, 1), pos(1, 1), pos(2, 1));
    expect(findPath({ cols: 3, rows: 3 }, pos(0, 0), pos(1, 2), blocked)).toBeNull();
  });

  it('按弧长取点：端点落在首尾，中间单调前进', () => {
    const pts = [
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 2, z: 2 },
    ];
    expect(pathLength(pts)).toBeCloseTo(4, 6);
    expect(pointAt(pts, 0)).toEqual({ x: 0, z: 0 });
    expect(pointAt(pts, 1)).toEqual({ x: 1, z: 0 });
    expect(pointAt(pts, 3)).toEqual({ x: 2, z: 1 });
    const end = pointAt(pts, 99);
    expect(end).toEqual({ x: 2, z: 2 });
  });
});
