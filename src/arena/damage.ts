/**
 * 建筑受伤的**渐进碎裂** —— 血量每跨过一档，外墙就崩掉一片：
 * 面片从 `WallShell` 上整块摘下来（洞是连成一片的），然后走简单弹道掉到地上。
 *
 * 落下去的就是**原来那块墙板**（尺寸、颜色、朝向都从模型里来），
 * 所以破洞的轮廓和地上的碎块是同一块东西 —— 不需要另画"破洞贴纸"。
 *
 * 物理只有重力 + 落地弹一下 —— P-096 起连这段也和废墟共用
 * `visuals/rigidFall.ts` 的 `stepRigid()`：角动量、摩擦、反弹只有一套常量，
 * 落地**不再瞬间把板子摆平**（那才是用户说的"斜躺着掉落却直直往下"）。
 * 生成顺序只由（楼号 + 第几档）决定，同一栋楼每次碎在同一个地方。
 */

import * as THREE from 'three';
import { Random } from '@engine/math/Random';
import type { HitKind } from './ArenaWorld';
import type { ShellPanel } from './models';
import type { WallShell } from './shell';
import { stepRigid, type RigidState } from './visuals/rigidFall';

/** 血量分数降到这些值时各崩一次（从高到低）。 */
export const HIT_THRESHOLDS = [0.8, 0.62, 0.45, 0.29, 0.15] as const;

/** 这个血量应该已经崩过几次（纯函数，给锁用）。 */
export function hitsFor(frac: number): number {
  let n = 0;
  for (const t of HIT_THRESHOLDS) if (frac <= t) n += 1;
  return n;
}

export interface DamageInfo {
  /** 楼心（世界坐标） */
  center: { x: number; z: number };
  /** 地面高度（世界坐标 y） */
  groundY: number;
  /** 模型单位的缩放（BUILDING_SCALE） */
  scale: number;
  seed: number;
}

interface Chunk {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  /** 躺平后的中心高度（也是刚体的地面） */
  restY: number;
  rest: boolean;
  /** 落地之后活了多久（用来"过一会儿慢慢消失"，见 DEBRIS_LIFE） */
  age: number;
}

interface Damaged extends DamageInfo {
  hits: number;
  shell: WallShell;
}

/** 场上最多留多少块碎块：再多就回收最老的（每栋楼最多 5 档 × 6 块 = 30） */
const MAX_DEBRIS = 70;
/**
 * 碎块落地后活多久（秒）以及最后几秒怎么消失。
 *
 * 用户 2026-11-05："废墟砖块掉到哪里都不影响，只要最后过一段时间后自动消失，慢慢消失就可以了。"
 * 上一版碎块**永远不会消失**，只在超过 `MAX_DEBRIS` 时回收最老的 ——
 * 一局打到 3 分钟，塔脚底下会积一圈永远躺着的板子。
 *
 * 消失方式用**缩小 + 下沉**，不用淡出：碎块的材质按颜色共享（`matOf`），
 * 改 opacity 会把场上所有同色碎块一起变透明。
 */
const DEBRIS_LIFE = 12;
const DEBRIS_FADE = 2.2;

export class DamageFx {
  /** 外壳崩开时的回调：让视图在破口处溅一把火星 */
  onBreach?: (x: number, z: number, y: number, dirX: number, dirZ: number) => void;
  /** 碎块落地时的回调：让视图在墙脚扬一小团土 */
  onLand?: (x: number, z: number, y: number) => void;
  private readonly states = new Map<number, Damaged>();
  private readonly debris: Chunk[] = [];
  private readonly mats = new Map<number, THREE.MeshStandardMaterial>();

  constructor(private readonly scene: THREE.Scene) {}

  register(id: number, info: DamageInfo, shell: WallShell): void {
    if (this.states.has(id)) return;
    this.states.set(id, { ...info, hits: 0, shell });
  }

  /** 每帧喂血量分数：跨过一档就崩一片（一次掉很多血会连崩多档）。 */
  sync(id: number, frac: number, kind: HitKind = 'blade'): void {
    const st = this.states.get(id);
    if (!st) return;
    const want = hitsFor(frac);
    while (st.hits < want) {
      this.breakOnce(st, st.hits, kind);
      st.hits += 1;
    }
  }

  /**
   * 整栋塌了：**剩下没崩的面片一块不剩地全掉到地上**（用户 2026-11-06）。
   *
   * 之前 `sync()` 只按血量档位崩（最多 5 档、每档 12% 左右），楼一没就
   * `forget()` 把整张外墙网格 dispose 掉 —— 墙上还立着的板子凭空消失。
   * 现在拆楼统一走这里：一次 `breach(count)` 摘光，逐块变成落体。
   * 返回掉了几块，方便视图 / 探针核实。
   */
  collapseAll(id: number, kind: HitKind = 'cannon'): number {
    const st = this.states.get(id);
    if (!st) return 0;
    const rnd = new Random(st.seed + 91129);
    const removed = st.shell.breach(st.shell.count, rnd);
    for (const panel of removed) this.dropPanel(st, panel, rnd, kind);
    st.shell.dispose(); // 网格已经空了；调用方负责把它从场景里摘掉
    this.states.delete(id);
    return removed.length;
  }

  /** 楼没了：外墙网格跟着释放，地上已经躺下的碎块留着。 */
  forget(id: number): void {
    const st = this.states.get(id);
    if (!st) return;
    st.shell.dispose();
    this.states.delete(id);
  }

  /** 碎块弹道：重力 + 落地弹一下，速度耗尽了就躺平；躺够 12 秒缩小下沉消失。 */
  update(dt: number): void {
    // 倒序：落地满 12 秒的要在这一趟里摘掉，正序删会跳元素
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const c = this.debris[i]!;
      if (c.rest) {
        c.age += dt;
        const left = DEBRIS_LIFE - c.age;
        if (left <= 0) {
          this.dropDebris(i);
          continue;
        }
        if (left < DEBRIS_FADE) {
          // 最后 2.2 秒：缩到 2% 并往下沉 0.4 格 —— 看起来是"陷进土里"
          const k = left / DEBRIS_FADE;
          c.mesh.scale.setScalar(Math.max(0.02, k));
          c.mesh.position.y = c.restY - (1 - k) * 0.4;
        }
        continue;
      }
      /**
       * P-096：逐帧刚体积分交给 `stepRigid()`，和废墟的 `rigidPoseAt()` 共用
       * 同一套重力/反弹/摩擦/角阻尼常量。位移与姿态一起推进，不再"位置在落、
       * 旋转却从出生起就定死"。
       */
      const p = c.mesh.position;
      const s: RigidState = {
        x: p.x, y: p.y, z: p.z,
        vx: c.vx, vy: c.vy, vz: c.vz,
        rx: c.mesh.rotation.x, ry: c.mesh.rotation.y, rz: c.mesh.rotation.z,
        wx: c.wx, wy: c.wy, wz: c.wz,
        floor: c.restY,
      };
      const r = stepRigid(s, dt);
      p.set(s.x, s.y, s.z);
      c.mesh.rotation.set(s.rx, s.ry, s.rz);
      c.vx = s.vx; c.vy = s.vy; c.vz = s.vz;
      c.wx = s.wx; c.wy = s.wy; c.wz = s.wz;
      if (r.rest) {
        /**
         * 静止：**姿态保持物理积分的结果**。
         * 旧版在这里 `rotation.set(-π/2 + tilt, ...)` 把板子瞬间摆平，
         * 于是翻滚了半天最后"啪"一下归位 —— 位置和旋转各说各话。
         * 现在每块歪成什么样由初速与角动量决定，落地就那样。
         */
        c.rest = true;
        c.age = 0;
        this.onLand?.(p.x, p.z, c.restY);
      }
    }
  }

  /** 摘掉一块碎块并释放它的几何（材质按颜色共享，不能 dispose）。 */
  private dropDebris(index: number): void {
    const c = this.debris[index]!;
    this.scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    this.debris.splice(index, 1);
  }

  get debrisCount(): number {
    return this.debris.length;
  }

  /** 现在有几栋楼记着伤（调试/锁用）。 */
  get damagedCount(): number {
    return this.states.size;
  }

  private breakOnce(st: Damaged, index: number, kind: HitKind): void {
    const rnd = new Random(st.seed + index * 977 + 73);
    // 每档崩掉约 12% 的墙板（48 块 → 6 块；12 块 → 2 块），至少 2 块
    const n = Math.min(6, Math.max(2, Math.round(st.shell.count * 0.12)));
    const removed = st.shell.breach(n, rnd);
    for (const panel of removed) this.dropPanel(st, panel, rnd, kind);
    // 破口中心 + 外法线：火星从这里往外溅
    if (removed.length > 0 && this.onBreach) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const p of removed) {
        ax += p.x;
        ay += p.y;
        az += p.z;
      }
      ax /= removed.length;
      ay /= removed.length;
      az /= removed.length;
      const face = removed[0]!;
      this.onBreach(
        st.center.x + ax * st.scale,
        st.center.z + az * st.scale,
        st.groundY + ay * st.scale,
        Math.sin(face.yaw),
        Math.cos(face.yaw),
      );
    }
  }

  /** 把一块墙板变成落体：位置/尺寸/颜色都从模型来。 */
  private dropPanel(st: Damaged, panel: ShellPanel, rnd: Random, kind: HitKind): void {
    const s = st.scale;
    const w = panel.w * s;
    const h = panel.h * s;
    const t = panel.t * s;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), this.matOf(panel.color));
    mesh.castShadow = true;
    mesh.position.set(
      st.center.x + panel.x * s,
      st.groundY + panel.y * s,
      st.center.z + panel.z * s,
    );
    mesh.rotation.set(rnd.next() * 0.5 - 0.25, panel.yaw, rnd.next() * 0.5 - 0.25);
    this.scene.add(mesh);

    // 外法线 = (sin yaw, 0, cos yaw)：板子从墙上往外崩，再带一点切向抖动
    const nx = Math.sin(panel.yaw);
    const nz = Math.cos(panel.yaw);
    /**
     * 炮弹炸散 vs 刀砍/箭射正常掉：
     * - 炮弹：**全方向**（不认墙面朝外那一条），速度 1.6–4.0 格/秒，转得更野；
     * - 刀箭：顺着墙面法线往外崩 0.5–1.4，慢一点，落地就躺下。
     */
    const blast = kind === 'cannon';
    const dir = rnd.next() * Math.PI * 2;
    const blastSpeed = 1.6 + rnd.next() * 2.4;
    this.debris.push({
      mesh,
      vx: blast ? Math.cos(dir) * blastSpeed : nx * (0.5 + rnd.next() * 0.9) + nz * (rnd.next() - 0.5) * 0.8,
      vy: blast ? 1.8 + rnd.next() * 1.8 : 0.9 + rnd.next() * 1.3,
      vz: blast ? Math.sin(dir) * blastSpeed : nz * (0.5 + rnd.next() * 0.9) - nx * (rnd.next() - 0.5) * 0.8,
      /**
       * 绕 x 的角速度带一个**朝躺倒方向的偏置**：薄墙板从竖着脱落，
       * 纯粹随机角速度会有一半概率落地时仍立着（旧版注释里的"砖头直插在地上"）。
       * 这是给定初速的**初始条件**，不是落地后硬摆姿态 —— 姿态仍由积分决定。
       */
      wx: (rnd.next() - 0.5) * (blast ? 18 : 8) - (blast ? 2.5 : 3.5),
      wy: (rnd.next() - 0.5) * (blast ? 16 : 8),
      wz: (rnd.next() - 0.5) * (blast ? 18 : 8),
      restY: st.groundY + t / 2 + 0.01,
      rest: false,
      age: 0,
    });

    while (this.debris.length > MAX_DEBRIS) this.dropDebris(0);
  }

  private matOf(color: number): THREE.MeshStandardMaterial {
    const hit = this.mats.get(color);
    if (hit) return hit;
    const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95 });
    this.mats.set(color, mat);
    return mat;
  }
}
