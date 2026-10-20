/**
 * 士兵视图 —— 把 Combat 里的单位画成素材包里的像素小人。
 *
 * 复用 P-001 那一套（图集 → 纹理 → DudeSprite），这里只多做两件事：
 * 1. **长相从 Roster 取**：自己人蓝衣、敌人随机，一个兵种一张脸，所以纹理张数有上限；
 * 2. **动作从状态推**：死了播 die（不循环）、在走播 run、刚开火播它自己的攻击动作、否则待命。
 *    单位表里没有"正在移动"这个字段，所以用"这一帧比上一帧挪了多少"来判 —— 便宜且不用改内核。
 */

import * as THREE from 'three';
import type { Combat, Unit } from '@game/systems/Combat';
import type { AnimName } from '@game/dudes/anims';
import { DudeGallery, DudeSprite, DEFAULT_APPEARANCE } from '@game/dudes/DudeView';
import type { DudePack } from '@game/dudes/pack';
import { Roster } from '@game/dudes/roster';

interface Tracked {
  sprite: DudeSprite;
  x: number;
  z: number;
  cooldown: number;
  /** 攻击动作还剩几秒播完；>0 期间不切回待命 */
  attackLeft: number;
}

export class UnitView {
  readonly group = new THREE.Group();
  private readonly tracked = new Map<number, Tracked>();

  constructor(
    private readonly combat: Combat,
    private readonly pack: DudePack,
    private readonly gallery: DudeGallery,
    private readonly roster: Roster,
    heightTiles: number,
  ) {
    this.group.name = 'units';
    void heightTiles;
    this.appearance = { ...DEFAULT_APPEARANCE, height: heightTiles };
  }

  private readonly appearance: typeof DEFAULT_APPEARANCE;

  get count(): number {
    return this.tracked.size;
  }

  sync(time: number, dt: number, yaw: number): void {
    const alive = new Set<number>();

    for (const unit of this.combat.liveUnits()) {
      alive.add(unit.id);
      let entry = this.tracked.get(unit.id);
      if (!entry) {
        const style = this.roster.styleFor(unit.def, unit.id);
        const { atlas, texture } = this.gallery.acquire(style, unit.def.anims);
        entry = {
          sprite: new DudeSprite(this.pack, atlas, texture, this.appearance),
          x: unit.x,
          z: unit.z,
          cooldown: unit.cooldown,
          attackLeft: 0,
        };
        this.group.add(entry.sprite.mesh);
        this.tracked.set(unit.id, entry);
      }

      const moved = Math.hypot(unit.x - entry.x, unit.z - entry.z);
      const justFired = unit.cooldown > entry.cooldown;
      entry.x = unit.x;
      entry.z = unit.z;
      entry.cooldown = unit.cooldown;
      if (justFired) entry.attackLeft = 0.55;
      else entry.attackLeft = Math.max(0, entry.attackLeft - dt);

      entry.sprite.moveTo(unit.x, unit.z);
      entry.sprite.faceCamera(yaw);
      entry.sprite.play(this.animOf(unit, entry, moved), time, !unit.dead);
      if (unit.dead) entry.sprite.mesh.position.y = this.appearance.height / 2 + this.appearance.lift;
    }

    for (const [id, entry] of this.tracked) {
      if (alive.has(id)) continue;
      entry.sprite.dispose();
      this.tracked.delete(id);
    }
  }

  /** 死亡 > 刚开火 > 在走 > 待命。顺序不能反：死了还在播 run 就穿帮了。 */
  private animOf(unit: Unit, entry: Tracked, moved: number): AnimName {
    if (unit.dead) return 'die';
    if (entry.attackLeft > 0) return unit.def.attackAnim;
    if (moved > 0.004) return 'run';
    if (unit.stun > 0) return 'hurt';
    return unit.def.idleAnim;
  }

  dispose(): void {
    for (const entry of this.tracked.values()) entry.sprite.dispose();
    this.tracked.clear();
  }
}
