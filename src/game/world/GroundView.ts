/**
 * 地面视图 —— 把 TileMap 摊成一次 draw call 的实例化地块。
 *
 * 46x46 = 2116 格。用普通 Mesh 是两千次 draw call，手机上直接卡死；
 * 两个 InstancedMesh（陆地 + 水面）就是 2 次。
 */

import * as THREE from 'three';
import { TILE_SIZE, cellToWorld } from '@engine/math/Grid';
import { fbm } from '@engine/math/Noise';
import { TERRAIN, type TerrainType } from '@game/config';
import type { TileMap } from './TileMap';

const SEAM = 0.965; // 格子之间留缝，正交俯视下才读得出"这是一格一格铺的"
const BASE_DEPTH = 1.2; // 地块往地下多厚，防止低俯角时看穿到背景

const BASE_COLOR = new Map<TerrainType, THREE.Color>();
for (const [name, spec] of Object.entries(TERRAIN) as [TerrainType, (typeof TERRAIN)[TerrainType]][]) {
  BASE_COLOR.set(name, new THREE.Color(spec.color));
}

/** 被建筑压住的地块颜色：压实泥地。 */
const PAID = new THREE.Color(0x6b6050);

export class GroundView {
  readonly group = new THREE.Group();
  private land!: THREE.InstancedMesh;
  private sea!: THREE.InstancedMesh;
  private readonly index = new Map<number, { mesh: THREE.InstancedMesh; slot: number }>();
  /** 每格建图时的抖动色：拆除后要还原成它，而不是还原成没有抖动的基色 */
  private readonly baseColor = new Map<number, THREE.Color>();
  private readonly dummy = new THREE.Object3D();

  constructor(private readonly map: TileMap) {
    this.build();
    this.group.name = 'ground';
  }

  private build(): void {
    const stride = this.map.size.cols;
    const geo = new THREE.BoxGeometry(TILE_SIZE * SEAM, 1, TILE_SIZE * SEAM);

    const landCells: { col: number; row: number; type: TerrainType }[] = [];
    const seaCells: { col: number; row: number; type: TerrainType }[] = [];

    for (const tile of this.map) {
      (tile.terrain === 'water' ? seaCells : landCells).push({
        col: tile.pos.col,
        row: tile.pos.row,
        type: tile.terrain,
      });
    }

    this.land = this.makeMesh(geo, landCells, this.solidMaterial(), stride);
    this.sea = this.makeMesh(geo, seaCells, this.waterMaterial(), stride);
    this.group.add(this.land, this.sea);
  }

  private solidMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
  }

  private waterMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      roughness: 0.18,
      metalness: 0.1,
      transparent: true,
      opacity: 0.86,
      flatShading: true,
    });
  }

  private makeMesh(
    geo: THREE.BufferGeometry,
    cells: { col: number; row: number; type: TerrainType }[],
    mat: THREE.MeshStandardMaterial,
    stride: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cells.length));
    mesh.count = cells.length;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;

    for (let slot = 0; slot < cells.length; slot++) {
      const { col, row, type } = cells[slot]!;
      const spec = TERRAIN[type];
      const { x, z } = cellToWorld({ col, row });
      const height = spec.thickness + BASE_DEPTH;

      this.dummy.position.set(x, spec.thickness - height / 2, z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, height, 1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(slot, this.dummy.matrix);

      // 同色微抖动：没有它整片草原会像一张色卡
      mesh.setColorAt(slot, this.terrainColor(col, row, type));

      const key = row * stride + col;
      this.baseColor.set(key, this.terrainColor(col, row, type));
      this.index.set(key, { mesh, slot });
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  /**
   * 一格的颜色 = 地形基色 + 由坐标决定的抖动。
   * 抖动公式只此一份：建图和地形变了要重涂（比如晶脉被压掉）必须得是同一条，
   * 否则同一格两次算出两个色，看上去就像闪了一下。
   */
  private terrainColor(col: number, row: number, type: TerrainType): THREE.Color {
    const jitter = fbm(col * 3.1, row * 2.7, { seed: 4242, frequency: 1, octaves: 1 }) - 0.5;
    return new THREE.Color(BASE_COLOR.get(type)!).offsetHSL(0, jitter * 0.06, jitter * 0.09);
  }

  /** 地形变了（晶脉被压成裸土）之后重涂这几格，并更新还原基色。 */
  recolor(cells: { col: number; row: number }[]): void {
    const stride = this.map.size.cols;
    const touched = new Set<THREE.InstancedMesh>();

    for (const cell of cells) {
      const key = cell.row * stride + cell.col;
      const entry = this.index.get(key);
      if (!entry) continue;
      const type = this.map.terrainAt(cell) ?? 'grass';
      const color = this.terrainColor(cell.col, cell.row, type);
      this.baseColor.set(key, color);
      entry.mesh.setColorAt(entry.slot, color);
      touched.add(entry.mesh);
    }
    for (const mesh of touched) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** 盖上建筑把地块压暗；拆除则还原成建图时那一份带抖动的色。 */
  markOccupied(origin: { col: number; row: number }, cols: number, rows: number, occupied: boolean): void {
    const stride = this.map.size.cols;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = (origin.row + r) * stride + (origin.col + c);
        const entry = this.index.get(key);
        if (!entry) continue;
        const restored = this.baseColor.get(key) ?? BASE_COLOR.get(this.map.terrainAt({ col: origin.col + c, row: origin.row + r }) ?? 'grass')!;
        entry.mesh.setColorAt(entry.slot, occupied ? PAID : restored);
        if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  update(time: number): void {
    // 水面整体轻微起伏：没有法线贴图也能让湖面不是一块死蓝
    this.sea.position.y = Math.sin(time * 0.9) * 0.035;
  }

  dispose(): void {
    this.land.geometry.dispose();
    this.land.material instanceof THREE.Material && this.land.material.dispose();
    this.sea.material instanceof THREE.Material && this.sea.material.dispose();
  }
}
