/**
 * 采矿运输队 —— 把"谁在采哪条矿"画成真的在小路上走的人。
 *
 * 一条硬要求：**这一层不许自己发明速度**。
 * 来回几秒 = `max(overhead, 2×格数) ÷ 脚程`，和经济结算同一条公式，
 * 于是"看见的忙碌程度"和"账上的产量"必然同步，不会出现人跑得飞快而产量没变。
 */

import * as THREE from 'three';
import type { GridPos } from '@engine/math/Grid';
import { cellToWorld, footprintCenter } from '@engine/math/Grid';
import { VEIN_WORK } from '@game/config';
import type { Building, GameWorld } from '@game/world/GameWorld';
import type { DudeAppearance, DudeGallery, DudeSprite } from './DudeView';
import type { DudeStyle } from './style';

/** 一次来回几秒。tiles = 占地边缘到矿点的格数。 */
export function tripSeconds(tiles: number, speed: number): number {
  return Math.max(VEIN_WORK.overheadTiles, 2 * tiles) / Math.max(0.01, speed);
}

interface Runner {
  buildingId: number;
  /** 地面锚点：只把"站在哪"写在这里，卡片自身的半身高由 DudeSprite 内部管 */
  anchor: THREE.Group;
  sprite: DudeSprite;
  from: { x: number; z: number; y: number };
  to: { x: number; z: number; y: number };
  trip: number;
  /** 步调错开量，不然一队人齐步走像复制粘贴 */
  phase: number;
}

export interface CrewDeps {
  world: GameWorld;
  gallery: DudeGallery;
  /** 一栋楼的长相由外部给：同 seed 同楼永远同一张脸，不用存盘 */
  styleFor: (building: Building) => DudeStyle;
  appearance?: DudeAppearance;
  /** 全局上限：一个小人一次 draw call，别让矿脉一多就把批次顶爆 */
  maxRunners?: number;
}

export class MiningCrew {
  readonly group = new THREE.Group();
  private readonly runners = new Map<string, Runner>();
  private readonly maxRunners: number;
  private skipped = 0;

  constructor(private readonly deps: CrewDeps) {
    this.maxRunners = deps.maxRunners ?? 48;
    this.group.name = 'crew';
  }

  get count(): number {
    return this.runners.size;
  }

  /** 因为上限而没派出去的任务数。非零就要在读数里看得见，不能悄悄丢。 */
  get capped(): number {
    return this.skipped;
  }

  countFor(buildingId: number): number {
    let n = 0;
    for (const r of this.runners.values()) if (r.buildingId === buildingId) n++;
    return n;
  }

  /**
   * 按世界当前的分配增删小人。
   * 只挂在 'vein:replanned' 上：那是分配唯一成型的地方，别处调用只会读到旧账。
   */
  sync(): void {
    const wanted = new Map<string, { building: Building; vein: GridPos; trip: number }>();

    for (const b of this.deps.world.buildings.values()) {
      if (!b.def.veinWork) continue;
      for (const claim of this.deps.world.claimsOf(b)) {
        const key = runnerKey(b.id, claim.vein);
        if (wanted.has(key)) continue;
        wanted.set(key, { building: b, vein: claim.vein, trip: tripSeconds(claim.tiles, b.def.veinWork.speed) });
      }
    }

    this.skipped = 0;
    const keep = new Map<string, { building: Building; vein: GridPos; trip: number }>();
    for (const [key, spec] of wanted) {
      // 已经在场的优先保留：不然每次重算都会因为"名额"把小人来回拆装
      if (this.runners.has(key) || keep.size < this.maxRunners) keep.set(key, spec);
      else this.skipped++;
    }

    for (const [key, runner] of [...this.runners]) {
      if (keep.has(key)) continue;
      runner.sprite.dispose();
      runner.anchor.removeFromParent();
      this.runners.delete(key);
    }

    for (const [key, spec] of keep) {
      if (this.runners.has(key)) continue;
      this.runners.set(key, this.spawn(key, spec.building, spec.vein, spec.trip));
    }
  }

  private spawn(key: string, building: Building, vein: GridPos, trip: number): Runner {
    const mineCenter = footprintCenter({ origin: building.origin, cols: building.cols, rows: building.rows });
    const veinCenter = cellToWorld(vein);
    const sprite = this.deps.gallery.createSprite(this.deps.styleFor(building), this.deps.appearance);

    const anchor = new THREE.Group();
    anchor.add(sprite.mesh);
    anchor.position.set(mineCenter.x, building.surfaceY, mineCenter.z);
    this.group.add(anchor);

    // 由 key 派生一个固定错位量：同一对"楼+矿"永远同一相位，重开一局也是
    const hash = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);

    return {
      buildingId: building.id,
      anchor,
      sprite,
      from: { x: mineCenter.x, z: mineCenter.z, y: building.surfaceY },
      to: { x: veinCenter.x, z: veinCenter.z, y: this.deps.world.map.surfaceY(vein) },
      trip,
      phase: (hash % 7) / 7,
    };
  }

  /**
   * 走位：一个来回分两段，前半去程、后半回程。
   * 用 `time % trip` 而不是累计位移，所以重建、快进、回放都不会让小人飘走。
   */
  update(time: number, yawDeg: number): void {
    for (const r of this.runners.values()) {
      const local = time + r.phase * r.trip;
      const u = (local % r.trip) / r.trip;
      const s = u < 0.5 ? u * 2 : 2 - u * 2;

      r.anchor.position.set(
        r.from.x + (r.to.x - r.from.x) * s,
        r.from.y + (r.to.y - r.from.y) * s,
        r.from.z + (r.to.z - r.from.z) * s,
      );
      r.sprite.faceCamera(yawDeg);
      r.sprite.play('run', local);
    }
  }

  dispose(): void {
    for (const r of this.runners.values()) {
      r.sprite.dispose();
      r.anchor.removeFromParent();
    }
    this.runners.clear();
  }
}

export const runnerKey = (buildingId: number, vein: GridPos): string => `${buildingId}@${vein.col},${vein.row}`;
