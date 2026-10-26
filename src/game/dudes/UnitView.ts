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
import { DEFAULT_APPEARANCE, DudeGallery, DudeSprite, facingFlip } from '@game/dudes/DudeView';
import type { DudePack } from '@game/dudes/pack';
import { Roster } from '@game/dudes/roster';

interface Tracked {
  sprite: DudeSprite;
  x: number;
  z: number;
  cooldown: number;
  /** 攻击动作还剩几秒播完；>0 期间不切回待命 */
  attackLeft: number;
  /** 受击动作还剩几秒播完 */
  hurtLeft: number;
  /** 上一帧的血量，用来检测挨打 */
  lastHp: number;
  /**
   * "还在走"的保留时间。
   *
   * 直接用 `moved > 0.004` 判跑步，会在"挤开/停下"那一两帧上反复真假 ——
   * 动画就在 run 和 idle 之间每帧切一次，屏幕上就是抽搐（"多个状态在打架"）。
   * 这里给 0.18 秒迟滞：只要这期间动过就一直算走。
   */
  runHold: number;
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
    private readonly surfaceAt: (x: number, z: number) => number,
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
          hurtLeft: 0,
          lastHp: unit.hp,
          runHold: 0,
        };
        this.group.add(entry.sprite.mesh);
        this.tracked.set(unit.id, entry);
      }

      const dx = unit.x - entry.x;
      const dz = unit.z - entry.z;
      const moved = Math.hypot(dx, dz);
      const justFired = unit.cooldown > entry.cooldown;
      entry.x = unit.x;
      entry.z = unit.z;
      entry.cooldown = unit.cooldown;
      if (justFired) entry.attackLeft = 0.55;
      else entry.attackLeft = Math.max(0, entry.attackLeft - dt);
      if (unit.hp < entry.lastHp && !unit.dead) entry.hurtLeft = 0.3;
      entry.lastHp = unit.hp;
      entry.hurtLeft = Math.max(0, entry.hurtLeft - dt);
      // 迟滞：这一帧动过就续 0.18 秒，否则慢慢放掉
      entry.runHold = moved > 0.004 ? 0.18 : Math.max(0, entry.runHold - dt);

      entry.sprite.moveTo(unit.x, unit.z);
      entry.sprite.mesh.position.y = this.surfaceAt(unit.x, unit.z) + this.appearance.height / 2 + this.appearance.lift;
      entry.sprite.faceCamera(yaw);
      // 朝向：默认朝右，往屏幕左走就镜像贴图（和矿工同一个入口）
      if (!unit.dead) entry.sprite.setFlipX(facingFlip(dx, dz, yaw, entry.sprite.flipped));
      entry.sprite.play(this.animOf(unit, entry), time, !unit.dead);
    }

    for (const [id, entry] of this.tracked) {
      if (alive.has(id)) continue;
      entry.sprite.dispose();
      this.tracked.delete(id);
    }
  }

  /** 死亡 > 刚开火 > 挨打 > 在走 > 待命。顺序不能反：死了还在播 run 就穿帮了。 */
  private animOf(unit: Unit, entry: Tracked): AnimName {
    if (unit.dead) return 'die';
    if (entry.attackLeft > 0) return unit.def.attackAnim;
    if (entry.hurtLeft > 0) return 'hurt';
    if (entry.runHold > 0) return 'run';
    if (unit.stun > 0) return 'hurt';
    return unit.def.idleAnim;
  }

  dispose(): void {
    for (const entry of this.tracked.values()) entry.sprite.dispose();
    this.tracked.clear();
  }
}
