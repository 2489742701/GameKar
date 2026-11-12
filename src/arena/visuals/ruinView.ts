/**
 * 废墟的**样子**：把 `fracture()` 切出来的碎块摆成一堆，以及它们的落地过程。
 *
 * 和 `ruins.ts` 的分工：那边只算"切成哪几块"（纯数据、可复现），
 * 这边决定"每块是立着还是躺着、往哪散、颜色多暗"。换渲染方式时只动这个文件。
 * P-096 起落地姿态由 `rigidFall.ts` 的确定性刚体积分给出，这里不再手造缓动。
 */

import * as THREE from 'three';
import { Random } from '@engine/math/Random';
import { fracture } from '../ruins';
import { rigidPoseAt, type RigidState } from './rigidFall';

/** 建筑种类 → 废墟的颜色族。 */
export function ruinStyleOf(kind: string): 'core' | 'tower' | 'wood' | 'stone' {
  if (kind === 'core') return 'core';
  if (kind === 'arrowTower' || kind === 'cannonTower') return 'tower';
  if (kind === 'mill' || kind === 'guild' || kind === 'barracks' || kind === 'house') return 'wood';
  return 'stone';
}

/**
 * 一堆废墟。
 *
 * 两块**立着的断墙** + 九块平躺的碎块 —— 用户 2026-11-02 说"砖头直直插在地上"，
 * 问题不是"插着"，是**全都一样平/一样薄**，没有"塌了一半的墙"这个剪影。
 *
 * @param seed 楼号派生的种子：同一栋楼拆两次长得一样，不同楼一定不一样
 */
export function makeRuin(
  cols: number,
  rows: number,
  seed: number,
  style: 'core' | 'tower' | 'wood' | 'stone',
): THREE.Group {
  const group = new THREE.Group();
  const parts = fracture(cols, rows, seed, 11);
  const rnd = new Random(seed + 991);
  const palette = {
    roof: 0x7a3a30,
    wall: 0x8a8175,
    wood: 0x5a4326,
  } as const;
  const tintBase = style === 'core' ? 0x8a7a55 : style === 'wood' ? 0x6b5638 : 0x807a70;

  parts.forEach((p, i) => {
    const base = p.part === 'roof' ? palette.roof : p.part === 'wall' ? palette.wall : palette.wood;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(base).lerp(new THREE.Color(tintBase), 0.25).multiplyScalar(0.6 + p.tone * 0.6).getHex(),
      roughness: 0.98,
      flatShading: true,
      transparent: true,
      opacity: 1,
    });
    // 前两块立着（薄、高、带一点点歪），其余平躺 —— 轮廓才有高低
    const standing = i < 2;
    const h = standing ? 0.6 + rnd.next() * 0.5 : p.h;
    const w = standing ? Math.min(p.w, 0.95) : p.w;
    const d = standing ? 0.12 : p.d;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.rotation.y = p.spin;
    if (standing) {
      // 断墙也不是笔直的：歪 3–8°，一眼是"塌出来的"
      mesh.rotation.z = (rnd.next() - 0.5) * 0.28;
    } else {
      mesh.rotation.x = (rnd.next() - 0.5) * 0.14;
      mesh.rotation.z = (rnd.next() - 0.5) * 0.14;
    }
    mesh.castShadow = true;
    /**
     * P-096：不再存"手造缓动的起点/摊开量"，改成一块**刚体初态**。
     * 位置从楼心附近起、带向外上方的初速与角速度；剩下的交给 rigidPoseAt
     * 按重力/反弹/摩擦解析推进。姿态会一路翻滚，不会"斜着躺好却直直往下掉"。
     */
    const body: RigidState = {
      x: p.x * 0.4,
      y: h / 2 + 0.7 + (i % 3) * 0.2,
      z: p.z * 0.4,
      vx: p.x * 0.9 + (rnd.next() - 0.5) * 0.6,
      vy: 1.0 + rnd.next() * 1.4,
      vz: p.z * 0.9 + (rnd.next() - 0.5) * 0.6,
      rx: mesh.rotation.x,
      ry: p.spin,
      rz: mesh.rotation.z,
      wx: (rnd.next() - 0.5) * 4,
      wy: (rnd.next() - 0.5) * 1.5,
      wz: (rnd.next() - 0.5) * 4,
      floor: h / 2,
    };
    mesh.userData['rigid'] = body;
    group.add(mesh);
  });

  group.userData['age'] = 0;
  return group;
}

/**
 * P-096：从**手造缓动**换成确定性刚体模拟。
 *
 * 旧版前 0.5 秒用 `ease = 1-(1-k)²` 把碎片从高处"缓"到地面、x/z 摊开，
 * 而 `rotation` 从造出来那一刻起就固定不动 —— 于是斜躺着的板子直直往下平移，
 * 姿态和位移各说各话。现在每块按 `rigidPoseAt(初态, age)` 解析推进：
 * 重力抛物线 + 触地反弹 + 摩擦 + 角动量衰减，旋转与位移来自同一套积分，
 * 而且不依赖帧率（age 一样，姿态就一定一样）。
 */
export function settleRuin(group: THREE.Group, age: number): void {
  for (const child of group.children) {
    const body = child.userData['rigid'] as RigidState | undefined;
    if (!body) continue;
    const pose = rigidPoseAt(body, age);
    child.position.set(pose.x, pose.y, pose.z);
    child.rotation.set(pose.rx, pose.ry, pose.rz);
  }
}
