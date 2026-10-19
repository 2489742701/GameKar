/**
 * 网格数学 —— 正交平铺地图的坐标地基。
 * 世界单位一律用 `{x,z}` 平面坐标表示，高度 y 由地形层负责，这样本文件不依赖渲染库。
 */

export interface GridPos {
  col: number;
  row: number;
}

export interface FlatSize {
  cols: number;
  rows: number;
}

export interface Footprint extends FlatSize {
  origin: GridPos;
}

/** 一格在世界里占多大。改这里等于改整张地图的密度。 */
export const TILE_SIZE = 1;

/** 单格 Map key：行优先，支持到 4096 列。 */
export const gridKey = (col: number, row: number) => row * 4096 + col;

export const pos = (col: number, row: number): GridPos => ({ col, row });

export const samePos = (a: GridPos, b: GridPos) => a.col === b.col && a.row === b.row;

export const toKey = (p: GridPos) => gridKey(p.col, p.row);

export function fromKey(key: number): GridPos {
  return { col: key % 4096, row: Math.floor(key / 4096) };
}

export function inBounds(p: GridPos, size: FlatSize): boolean {
  return p.col >= 0 && p.row >= 0 && p.col < size.cols && p.row < size.rows;
}

/** 切比雪夫距离 —— 斜着走也算一步，符合 8 向RTS 的直觉。 */
export function chebyshev(a: GridPos, b: GridPos): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

export function manhattan(a: GridPos, b: GridPos): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

export const ORTHOGONAL: readonly GridPos[] = [
  pos(1, 0),
  pos(-1, 0),
  pos(0, 1),
  pos(0, -1),
];

export const DIAGONAL: readonly GridPos[] = [...ORTHOGONAL, pos(1, 1), pos(1, -1), pos(-1, 1), pos(-1, -1)];

export function neighbors(p: GridPos, size: FlatSize, eightWay = true): GridPos[] {
  const out: GridPos[] = [];
  for (const d of eightWay ? DIAGONAL : ORTHOGONAL) {
    const q = pos(p.col + d.col, p.row + d.row);
    if (inBounds(q, size)) out.push(q);
  }
  return out;
}

/** 占地矩形的左上角与尺寸（建筑 2x2 这类）。 */
export function footprintRect(fp: Footprint): GridPos[] {
  const out: GridPos[] = [];
  for (let r = 0; r < fp.rows; r++) {
    for (let c = 0; c < fp.cols; c++) {
      out.push(pos(fp.origin.col + c, fp.origin.row + r));
    }
  }
  return out;
}

/** 世界平面坐标 -> 格子（向下取整，格 (0,0) 覆盖 [0,1)）。 */
export function worldToCell(x: number, z: number, origin: GridPos = pos(0, 0)): GridPos {
  return pos(origin.col + Math.floor(x / TILE_SIZE), origin.row + Math.floor(z / TILE_SIZE));
}

/** 格子 -> 格心世界坐标。 */
export function cellToWorld(p: GridPos): { x: number; z: number } {
  return {
    x: (p.col + 0.5) * TILE_SIZE,
    z: (p.row + 0.5) * TILE_SIZE,
  };
}

/** 占地矩形 -> 世界平面中心（多格建筑的锚点）。 */
export function footprintCenter(fp: Footprint): { x: number; z: number } {
  return {
    x: (fp.origin.col + fp.cols / 2) * TILE_SIZE,
    z: (fp.origin.row + fp.rows / 2) * TILE_SIZE,
  };
}

export function mapCenter(size: FlatSize): GridPos {
  return pos(Math.floor(size.cols / 2), Math.floor(size.rows / 2));
}
