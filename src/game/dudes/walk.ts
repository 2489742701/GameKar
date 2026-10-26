/**
 * 小人寻路 —— 网格 A*，给"矿工从楼走到矿脉"用。
 *
 * 为什么不用士兵那套流场：流场是**给一整波敌人**算的（一次算、多人复用、目标会动），
 * 小人是个体的点对点往返，目标固定、数量少（上限 48），A* 一次算完缓存住更划算，
 * 而且能顺手拿到路径长度（走位按弧长插值才不会被拐角拽着跑）。
 *
 * 8 方向 + 禁止斜穿墙角：斜着切过两个障碍的共用顶点，屏幕上就是人从石头角上滑过去。
 */

import type { FlatSize, GridPos } from '@engine/math/Grid';

export type Blocked = (cell: GridPos) => boolean;

const SQRT2 = Math.SQRT2;

const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

interface Node {
  col: number;
  row: number;
  g: number;
  f: number;
  from: number;
}

/**
 * 找一条从 from 到 to 的格子路径（含首尾）。
 * 走不通返回 null —— 调用方要自己决定"那就直着走"，不要在这里偷偷兜底。
 */
export function findPath(
  size: FlatSize,
  from: GridPos,
  to: GridPos,
  blocked: Blocked,
  limit = 6000,
): GridPos[] | null {
  const w = size.cols;
  const key = (col: number, row: number) => row * w + col;
  const inBounds = (col: number, row: number) => col >= 0 && row >= 0 && col < size.cols && row < size.rows;

  const start = key(from.col, from.row);
  const goal = key(to.col, to.row);
  if (start === goal) return [from];

  const open: Node[] = [{ col: from.col, row: from.row, g: 0, f: 0, from: -1 }];
  const best = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  let expanded = 0;

  while (open.length > 0 && expanded < limit) {
    // 小顶堆太小题大做：格子数 ~2000，线性找最小比维护堆更短更好读
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[bi]!.f) bi = i;
    const cur = open.splice(bi, 1)[0]!;
    const curKey = key(cur.col, cur.row);
    if (curKey === goal) {
      const out: GridPos[] = [];
      let k: number | undefined = goal;
      while (k !== undefined) {
        out.push({ col: k % w, row: Math.floor(k / w) });
        k = cameFrom.get(k);
      }
      return out.reverse();
    }
    if (closed.has(curKey)) continue;
    closed.add(curKey);
    expanded++;

    for (const [dc, dr, cost] of NEIGHBORS) {
      const col = cur.col + dc;
      const row = cur.row + dr;
      if (!inBounds(col, row)) continue;
      const k = key(col, row);
      // 终点也照样判：矿点要是被楼压着，就该让上层记 noPath，
      // 而不是让他一路走到楼里再卡住
      if (blocked({ col, row })) continue;
      // 斜走时两个直邻都得通，否则就是从墙角缝里钻过去
      if (dc !== 0 && dr !== 0) {
        if (blocked({ col: cur.col + dc, row: cur.row })) continue;
        if (blocked({ col: cur.col, row: cur.row + dr })) continue;
      }
      const g = cur.g + cost;
      const prev = best.get(k);
      if (prev !== undefined && prev <= g) continue;
      best.set(k, g);
      cameFrom.set(k, curKey);
      const h = Math.hypot(col - to.col, row - to.row);
      open.push({ col, row, g, f: g + h * 1.08, from: curKey });
    }
  }
  return null;
}

/** 路径总长（世界单位 = 格）。 */
export function pathLength(points: readonly { x: number; z: number }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  }
  return len;
}

/** 按弧长取路径上的点；distance 会被夹到 [0, 总长]。 */
export function pointAt(points: readonly { x: number; z: number }[], distance: number): { x: number; z: number } {
  if (points.length === 0) return { x: 0, z: 0 };
  if (points.length === 1) return points[0]!;
  let left = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg <= 1e-6) continue;
    if (left <= seg) {
      const t = left / seg;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    left -= seg;
  }
  return points[points.length - 1]!;
}
