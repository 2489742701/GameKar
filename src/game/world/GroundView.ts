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
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

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
      const jitter = fbm(col * 3.1, row * 2.7, { seed: 4242, frequency: 1, octaves: 1 }) - 0.5;
      this.color.copy(BASE_COLOR.get(type)!).offsetHSL(0, jitter * 0.06, jitter * 0.09);
      mesh.setColorAt(slot, this.color);

      this.index.set(row * stride + col, { mesh, slot });
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  /** 盖上建筑后把地块压暗，视觉上"地被占用了"。 */
  markOccupied(origin: { col: number; row: number }, cols: number, rows: number, occupied: boolean): void {
    const stride = this.map.size.cols;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = (origin.row + r) * stride + (origin.col + c);
        const entry = this.index.get(key);
        if (!entry) continue;
        if (occupied) {
          entry.mesh.setColorAt(entry.slot, PAID);
        } else {
          const pos = { col: origin.col + c, row: origin.row + r };
          const type = this.map.terrainAt(pos) ?? 'grass';
          entry.mesh.setColorAt(entry.slot, BASE_COLOR.get(type)!);
        }
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
