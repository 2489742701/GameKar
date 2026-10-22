/**
 * 建筑视图 —— 世界里的 Building 记录 ↔ 场景里的 Group，一一对应。
 *
 * 工地骨架和实体模型同时挂在同一个根节点上：
 * 实体按建造进度沿 Y 从 0.15 长到 1.0，骨架在封顶那一刻撤走。
 * 缩放会把模型最低点一起抬起来（各楼的底面实测在 -0.54..0 之间，不是"都在 0"），
 * 所以每一档进度都要按 `keepBaseOffset` 补一笔下移，底面才钉在同一处地面上。
 */

import * as THREE from 'three';
import { footprintCenter } from '@engine/math/Grid';
import { keepBaseOffset } from '@game/models/kit';
import type { ModelLibrary } from '@game/models/registry';
import type { Building } from './GameWorld';

const GROWN = 1;
const GROUNDED = 0.15;

interface Entry {
  root: THREE.Group;
  body: THREE.Group;
  site: THREE.Group;
  /** 选中框要用的实际高度（含屋顶） */
  height: number;
  /** 未缩放时的最低点，缩放补偿按它算 */
  baseY: number;
}

export class BuildingView {
  readonly group = new THREE.Group();
  private readonly entries = new Map<number, Entry>();
  private readonly box = new THREE.Box3();

  constructor(private readonly library: ModelLibrary) {
    this.group.name = 'buildings';
  }

  add(building: Building): void {
    const { origin, cols, rows, def } = building;
    const center = footprintCenter({ origin, cols, rows });

    const root = new THREE.Group();
    root.position.set(center.x, building.surfaceY, center.z);
    root.userData.buildingId = building.id;

    const body = this.library.create(def.model);
    const site = this.library.create('scaffold');
    // 骨架按 2x2 画的，小建筑按比例缩
    site.scale.set(cols / 2, 1, rows / 2);

    root.add(body, site);
    this.group.add(root);

    this.box.setFromObject(body);
    const height = Math.max(0.4, this.box.max.y - this.box.min.y);
    const baseY = this.box.min.y;

    this.entries.set(building.id, { root, body, site, height, baseY });
    this.applyProgress(building);
  }

  remove(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.root.removeFromParent();
    // Group 里的 Mesh 共享缓存几何与材质，removeFromParent 就是全部要做的事
    this.entries.delete(id);
  }

  heightOf(id: number): number {
    return this.entries.get(id)?.height ?? 1;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 逐帧同步进度；只写缩放与一处下移，不做几何重建。 */
  applyProgress(building: Building): void {
    const entry = this.entries.get(building.id);
    if (!entry) return;
    const p = building.progress;
    const s = GROUNDED + (GROWN - GROUNDED) * p;
    entry.body.scale.y = s;
    // 补回被缩放抬起来的那一段，底面才一直钉在地面上
    entry.body.position.y = keepBaseOffset(entry.baseY, s);
    entry.site.visible = !building.built;
  }

  syncAll(buildings: Iterable<Building>): void {
    for (const b of buildings) this.applyProgress(b);
  }
}
