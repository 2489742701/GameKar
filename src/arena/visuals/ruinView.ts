/**
 * 废墟的**样子**：把 `fracture()` 切出来的碎块摆成一堆，以及它那 0.5 秒的摊开动画。
 *
 * 和 `ruins.ts` 的分工：那边只算"切成哪几块"（纯数据、可复现），
 * 这边决定"每块是立着还是躺着、往哪散、颜色多暗"。换渲染方式时只动这个文件。
 */

import * as THREE from 'three';
import { Random } from '@engine/math/Random';
import { fracture } from '../ruins';

/** 建筑种类 → 废墟的颜色族。 */
export function ruinStyleOf(kind: string): 'core' | 'tower' | 'wood' | 'stone' {
  if (kind === 'core') return 'core';
  if (kind === 'arrowTower' || kind === 'cannonTower') return 'tower';
  if (kind === 'mill' || kind === 'barracks' || kind === 'house') return 'wood';
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
    mesh.userData['home'] = { x: p.x, z: p.z, y: h / 2 };
    // 摊开的幅度：0.6 倍（0.85 试过，散成一圈砖）
    mesh.userData['burst'] = { x: p.x * 0.6, z: p.z * 0.6, i };
    group.add(mesh);
  });

  group.userData['age'] = 0;
  return group;
}

/**
 * 前 0.5 秒：从原位向四周摊开、从高处落下。之后不再动。
 *
 * x/z 用 `+ burst * ease`：从**原位**逐渐摊到外侧。
 * 上一版是 `+ burst * (1 - ease)` —— 从外侧吸回原位，读起来像倒放。
 */
export function settleRuin(group: THREE.Group, age: number): void {
  const k = Math.min(1, age / 0.5);
  const ease = 1 - (1 - k) * (1 - k);
  for (const child of group.children) {
    const home = child.userData['home'] as { x: number; z: number; y: number } | undefined;
    const burst = child.userData['burst'] as { x: number; z: number; i: number } | undefined;
    if (!home || !burst) continue;
    child.position.set(
      home.x + burst.x * ease,
      home.y + (1 - ease) * (0.7 + (burst.i % 3) * 0.2),
      home.z + burst.z * ease,
    );
  }
}
