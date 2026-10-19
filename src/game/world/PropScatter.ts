/**
 * 地表装饰散布 —— 树、灌、岩按地形和密度长出来，晶簇单独成组（要发光）。
 *
 * 每种可合并的装饰一个 InstancedMesh：整张图的地面细节加起来不超过 4 次 draw call。
 */

import * as THREE from 'three';
import type { GridPos } from '@engine/math/Grid';
import { cellToWorld } from '@engine/math/Grid';
import { Random } from '@engine/math/Random';
import { fbm } from '@engine/math/Noise';
import type { TerrainType } from '@game/config';
import { buildModel, mergeGeometry } from '@game/models/kit';
import { propModels } from '@game/models/props';
import type { TileMap } from './TileMap';

interface ScatterRule {
  model: string;
  on: readonly TerrainType[];
  /** 每格基础命中概率，再乘一层聚簇噪声 */
  density: number;
  scale: readonly [number, number];
  /** 距出生点多近以内不放东西（留出广场空地） */
  keepClear: number;
}

const RULES: ScatterRule[] = [
  { model: 'broadleaf', on: ['grass'], density: 0.09, scale: [0.8, 1.25], keepClear: 3 },
  { model: 'pine', on: ['grass', 'sand'], density: 0.055, scale: [0.75, 1.15], keepClear: 3 },
  { model: 'bush', on: ['grass', 'sand'], density: 0.07, scale: [0.7, 1.2], keepClear: 2 },
  { model: 'rockCluster', on: ['rock', 'sand', 'grass'], density: 0.16, scale: [0.7, 1.4], keepClear: 2 },
];

interface Placed {
  mesh: THREE.InstancedMesh;
  slot: number;
  /** 原位矩阵：拆除建筑时要能一模一样放回去 */
  matrix: THREE.Matrix4;
}

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class PropScatter {
  readonly group = new THREE.Group();
  private readonly dummy = new THREE.Object3D();
  /** 每格最多一件装饰：两批规则抢同一格会长出"套娃树" */
  private readonly placed = new Map<number, Placed>();
  /** 发光晶簇不合批，只能整组 visible 开关 */
  private readonly clusters = new Map<number, THREE.Object3D>();

  constructor(
    private readonly map: TileMap,
    seed: number,
  ) {
    this.group.name = 'props';
    const rng = new Random(seed ^ 0x917a);
    const home: GridPos = { col: Math.floor(map.size.cols / 2), row: Math.floor(map.size.rows / 2) };

    for (const rule of RULES) this.scatterRule(rule, rng, home, seed);
    this.scatterVeinCrystals();
  }

  private keyOf(p: GridPos): number {
    return p.row * this.map.size.cols + p.col;
  }

  /**
   * 建筑盖上去时压掉这一格的装饰，拆除时还原。
   * 不做这件事的话，树会直接从市集屋顶里长出来。
   */
  setHidden(cells: GridPos[], hidden: boolean): void {
    const dirty = new Set<THREE.InstancedMesh>();

    for (const cell of cells) {
      const key = this.keyOf(cell);
      const entry = this.placed.get(key);
      if (entry) {
        entry.mesh.setMatrixAt(entry.slot, hidden ? HIDDEN : entry.matrix);
        dirty.add(entry.mesh);
      }
      const cluster = this.clusters.get(key);
      if (cluster) cluster.visible = !hidden;
    }

    for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  /** 这一格有没有落到装饰（树/灌/岩/晶簇）。给测试和后续"清理地表"用。 */
  hasPropAt(cell: GridPos): boolean {
    const key = this.keyOf(cell);
    return this.placed.has(key) || this.clusters.has(key);
  }

  get propCount(): number {
    return this.placed.size + this.clusters.size;
  }

  private chebyshev(p: GridPos, q: GridPos): number {
    return Math.max(Math.abs(p.col - q.col), Math.abs(p.row - q.row));
  }

  private scatterRule(rule: ScatterRule, rng: Random, home: GridPos, seed: number): void {
    const spec = propModels[rule.model];
    if (!spec) return;

    const cells: GridPos[] = [];
    for (const tile of this.map) {
      if (!rule.on.includes(tile.terrain)) continue;
      if (this.chebyshev(tile.pos, home) <= rule.keepClear) continue;
      if (tile.buildingId >= 0) continue;
      if (this.placed.has(this.keyOf(tile.pos))) continue;
      // 密度乘聚簇噪声：纯随机撒像撒盐，带噪声才像一片林子
      const clump = fbm(tile.pos.col, tile.pos.row, { seed, frequency: 1 / 6, octaves: 2 });
      if (clump < 0.42) continue;
      if (rng.next() > rule.density * (0.5 + clump)) continue;
      cells.push(tile.pos);
    }
    if (cells.length === 0) return;

    const geo = mergeGeometry(`prop:${rule.model}`, spec);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    cells.forEach((cell, slot) => {
      const { x, z } = cellToWorld(cell);
      this.dummy.position.set(x + rng.float(-0.22, 0.22), this.map.surfaceY(cell), z + rng.float(-0.22, 0.22));
      this.dummy.rotation.set(0, rng.float(0, Math.PI * 2), 0);
      this.dummy.scale.setScalar(rng.float(rule.scale[0], rule.scale[1]));
      this.dummy.updateMatrix();

      mesh.setMatrixAt(slot, this.dummy.matrix);
      this.placed.set(this.keyOf(cell), { mesh, slot, matrix: this.dummy.matrix.clone() });
    });

    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /** 发光物不合批：顶点色走不了 emissive，而晶脉的"亮"正是它的玩法信号。 */
  private scatterVeinCrystals(): void {
    const spec = propModels.crystalCluster;
    if (!spec) return;
    for (const tile of this.map) {
      if (tile.terrain !== 'vein') continue;
      if (tile.buildingId >= 0) continue;
      const { x, z } = cellToWorld(tile.pos);
      const prop = buildModel(spec);
      prop.position.set(x, tile.surfaceY, z);
      this.group.add(prop);
      this.clusters.set(this.keyOf(tile.pos), prop);
    }
  }
}
