/**
 * 建筑受伤的**渐进碎裂** —— 血量每跨过一档，外墙就崩掉一片：
 * 面片从 `WallShell` 上整块摘下来（洞是连成一片的），然后走简单弹道掉到地上。
 *
 * 落下去的就是**原来那块墙板**（尺寸、颜色、朝向都从模型里来），
 * 所以破洞的轮廓和地上的碎块是同一块东西 —— 不需要另画"破洞贴纸"。
 *
 * 物理只有重力 + 落地躺平：几块板不值得引刚体引擎。
 * 生成顺序只由（楼号 + 第几档）决定，同一栋楼每次碎在同一个地方。
 */

import * as THREE from 'three';
import { Random } from '@engine/math/Random';
import type { ShellPanel } from './models';
import type { WallShell } from './shell';

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
  /** 躺平后的中心高度 */
  restY: number;
  /** 躺平时的朝向（外墙原朝向） */
  yaw: number;
  rest: boolean;
}

interface Damaged extends DamageInfo {
  hits: number;
  shell: WallShell;
}

const GRAVITY = 16;
const BOUNCE = 0.3;
/** 场上最多留多少块碎块：再多就回收最老的（每栋楼最多 5 档 × 6 块 = 30） */
const MAX_DEBRIS = 70;

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
  sync(id: number, frac: number): void {
    const st = this.states.get(id);
    if (!st) return;
    const want = hitsFor(frac);
    while (st.hits < want) {
      this.breakOnce(st, st.hits);
      st.hits += 1;
    }
  }

  /** 楼没了：外墙网格跟着释放，地上已经躺下的碎块留着。 */
  forget(id: number): void {
    const st = this.states.get(id);
    if (!st) return;
    st.shell.dispose();
    this.states.delete(id);
  }

  /** 碎块弹道：重力 + 落地弹一下，速度耗尽了就躺平。 */
  update(dt: number): void {
    for (const c of this.debris) {
      if (c.rest) continue;
      c.vy -= GRAVITY * dt;
      const p = c.mesh.position;
      p.x += c.vx * dt;
      p.y += c.vy * dt;
      p.z += c.vz * dt;
      c.mesh.rotation.x += c.wx * dt;
      c.mesh.rotation.y += c.wy * dt;
      c.mesh.rotation.z += c.wz * dt;
      if (p.y <= c.restY) {
        p.y = c.restY;
        if (Math.abs(c.vy) > 1.2) {
          c.vy = -c.vy * BOUNCE;
          c.vx *= 0.6;
          c.vz *= 0.6;
          c.wx *= 0.5;
          c.wy *= 0.5;
          c.wz *= 0.5;
        } else {
          // 躺平：墙板落地不会立着，顺着原来的朝向铺在地上
          c.mesh.rotation.set(-Math.PI / 2, c.yaw, 0);
          c.vy = 0;
          c.rest = true;
          this.onLand?.(c.mesh.position.x, c.mesh.position.z, c.restY);
        }
      }
    }
  }

  get debrisCount(): number {
    return this.debris.length;
  }

  /** 现在有几栋楼记着伤（调试/锁用）。 */
  get damagedCount(): number {
    return this.states.size;
  }

  private breakOnce(st: Damaged, index: number): void {
    const rnd = new Random(st.seed + index * 977 + 73);
    // 每档崩掉约 12% 的墙板（48 块 → 6 块；12 块 → 2 块），至少 2 块
    const n = Math.min(6, Math.max(2, Math.round(st.shell.count * 0.12)));
    const removed = st.shell.breach(n, rnd);
    for (const panel of removed) this.dropPanel(st, panel, rnd);
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
  private dropPanel(st: Damaged, panel: ShellPanel, rnd: Random): void {
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
    this.debris.push({
      mesh,
      vx: nx * (0.5 + rnd.next() * 0.9) + nz * (rnd.next() - 0.5) * 0.8,
      vy: 0.9 + rnd.next() * 1.3,
      vz: nz * (0.5 + rnd.next() * 0.9) - nx * (rnd.next() - 0.5) * 0.8,
      wx: (rnd.next() - 0.5) * 8,
      wy: (rnd.next() - 0.5) * 8,
      wz: (rnd.next() - 0.5) * 8,
      restY: st.groundY + t / 2 + 0.01,
      yaw: panel.yaw,
      rest: false,
    });

    while (this.debris.length > MAX_DEBRIS) {
      const old = this.debris.shift()!;
      this.scene.remove(old.mesh);
      old.mesh.geometry.dispose();
    }
  }

  private matOf(color: number): THREE.MeshStandardMaterial {
    const hit = this.mats.get(color);
    if (hit) return hit;
    const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95 });
    this.mats.set(color, mat);
    return mat;
  }
}
