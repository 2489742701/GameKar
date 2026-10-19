/**
 * 地块地图 —— 一张有地形、有归属、能问"这块地能不能盖"的棋盘。
 * 用 TypedArray 存，46x46 的地图常驻内存不到 30KB。
 */

import type { FlatSize, GridPos } from '@engine/math/Grid';
import { footprintRect, inBounds, toKey } from '@engine/math/Grid';
import { TERRAIN, TERRAIN_ORDER, type TerrainType } from '@game/config';

const NONE = -1;

export interface TileInfo {
  pos: GridPos;
  terrain: TerrainType;
  /** 地块顶面高度（世界 Y），建筑落位要按它垫高 */
  surfaceY: number;
  buildingId: number;
}

export class TileMap {
  readonly size: FlatSize;
  private readonly terrain: Uint8Array;
  private readonly occupant: Int32Array;

  constructor(size: FlatSize, terrain?: Uint8Array) {
    this.size = size;
    this.terrain = terrain ?? new Uint8Array(size.cols * size.rows);
    this.occupant = new Int32Array(size.cols * size.rows).fill(NONE);
  }

  private idx(p: GridPos): number {
    return inBounds(p, this.size) ? p.row * this.size.cols + p.col : -1;
  }

  get(index: number): TerrainType {
    return TERRAIN_ORDER[this.terrain[index] ?? 0]!;
  }

  /** 越界返回 null，让调用方自己决定"边界外算不算挡"。 */
  terrainAt(p: GridPos): TerrainType | null {
    const i = this.idx(p);
    return i < 0 ? null : this.get(i);
  }

  surfaceY(p: GridPos): number {
    const i = this.idx(p);
    return i < 0 ? 0 : TERRAIN[this.get(i)].thickness;
  }

  /** 占地内最高的一块：多格建筑不能陷进地里 */
  footprintSurfaceY(origin: GridPos, cols: number, rows: number): number {
    let top = 0;
    for (const cell of footprintRect({ origin, cols, rows })) {
      top = Math.max(top, this.surfaceY(cell));
    }
    return top;
  }

  buildingAt(p: GridPos): number | null {
    const i = this.idx(p);
    if (i < 0) return null;
    const v = this.occupant[i]!;
    return v === NONE ? null : v;
  }

  /** 地形许可 + 无占用；不包含"付不付得起""人够不够"这类规则。 */
  isFree(p: GridPos): boolean {
    const i = this.idx(p);
    if (i < 0) return false;
    return TERRAIN[this.get(i)].buildable && this.occupant[i] === NONE;
  }

  setTerrain(p: GridPos, type: TerrainType): void {
    const i = this.idx(p);
    if (i >= 0) this.terrain[i] = TERRAIN_ORDER.indexOf(type);
  }

  /** 整块占地必须全可用才写入；返回 false 表示这地方盖不了。 */
  claim(origin: GridPos, cols: number, rows: number, buildingId: number): boolean {
    const cells = footprintRect({ origin, cols, rows });
    if (!cells.every((c) => this.isFree(c))) return false;
    for (const c of cells) {
      const i = this.idx(c);
      if (i >= 0) this.occupant[i] = buildingId;
    }
    return true;
  }

  release(buildingId: number): void {
    for (let i = 0; i < this.occupant.length; i++) {
      if (this.occupant[i] === buildingId) this.occupant[i] = NONE;
    }
  }

  /** 遍历：`for (const tile of map) ...` */
  *[Symbol.iterator](): Generator<TileInfo> {
    for (let row = 0; row < this.size.rows; row++) {
      for (let col = 0; col < this.size.cols; col++) {
        const p: GridPos = { col, row };
        const i = row * this.size.cols + col;
        const terrain = this.get(i);
        yield {
          pos: p,
          terrain,
          surfaceY: TERRAIN[terrain].thickness,
          buildingId: this.occupant[i]!,
        };
      }
    }
  }

  countTerrain(type: TerrainType): number {
    const code = TERRAIN_ORDER.indexOf(type);
    let n = 0;
    for (let i = 0; i < this.terrain.length; i++) if (this.terrain[i] === code) n++;
    return n;
  }

  /** 调试与存档用：原始地形层。 */
  get rawTerrain(): Uint8Array {
    return this.terrain;
  }

  keyAt(p: GridPos): number {
    return toKey(p);
  }
}
