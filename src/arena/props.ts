/**
 * 对战模式的"谁的楼"三件套：石台、旗帜、阵营配色。
 *
 * 设计取舍（用户 2026-10-27 的反馈）：之前我在地上贴了一块纯色方板当标识 ——
 * 那看起来像地毯，不像建筑的一部分。改成**有形的石台**：
 *   ① 底层深石（比建筑略大一圈）
 *   ② 上层阵营色台阶（收进半格）
 *   ③ 台阶边缘一道亮色沿
 * 三层叠起来才像"这栋楼立在一块刻着自己颜色的石台上"，而不是地上铺了块布。
 *
 * 旗帜单独成件，布面用几段正弦摆动（每帧改顶点，不用着色器）：
 * 炮塔、箭塔、兵营、磨坊、核心各一面，杆高不同，远看就能数出阵营。
 */

import * as THREE from 'three';
import type { Side } from './config';
import { sideColor } from './theme';

/** 把阵营色压暗/提亮，做石台的两个层次。 */
export function shade(hex: number, factor: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((hex & 255) * factor));
  return (r << 16) | (g << 8) | b;
}

export interface Plinth {
  group: THREE.Group;
}

/**
 * 石台：底色深石 + 阵营色台阶 + 亮边。
 * 尺寸用**格**给（调用方传建筑占地），本件内部按占地铺满。
 */
export function makePlinth(cols: number, rows: number, side: Side): Plinth {
  const group = new THREE.Group();
  const tint = sideColor(side);
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a4038, flatShading: true, roughness: 0.95 });
  const step = new THREE.MeshStandardMaterial({ color: shade(tint, 0.62), flatShading: true, roughness: 0.85 });
  const rim = new THREE.MeshStandardMaterial({
    color: tint,
    emissive: tint,
    emissiveIntensity: 0.45,
    flatShading: true,
    roughness: 0.6,
  });

  const bottom = new THREE.Mesh(new THREE.BoxGeometry(cols * 0.98, 0.1, rows * 0.98), dark);
  bottom.position.y = 0.05;
  bottom.receiveShadow = true;

  const upper = new THREE.Mesh(new THREE.BoxGeometry(cols * 0.86, 0.1, rows * 0.86), step);
  upper.position.y = 0.15;
  upper.receiveShadow = true;

  const edge = new THREE.Mesh(new THREE.BoxGeometry(cols * 0.9, 0.035, rows * 0.9), rim);
  edge.position.y = 0.2;
  edge.receiveShadow = true;

  group.add(bottom, upper, edge);
  return { group };
}

export interface Banner {
  group: THREE.Group;
  /** 每帧喂时间，布面自己摆 */
  update(time: number): void;
}

const CLOTH_W = 0.95;
const CLOTH_H = 0.5;
const SEGS = 7;

/**
 * 会飘的旗：一根杆 + 一条分段的布。
 * 布面用 `PlaneGeometry(…, SEGS, 1)` 的顶点做正弦位移 —— 每帧改 8×2 个顶点，
 * 比上着色器省事，也比"整块平面转一转"像旗子。
 */
export function makeBanner(side: Side, poleHeight = 1.1): Banner {
  const group = new THREE.Group();
  const tint = sideColor(side);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.042, poleHeight, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4526, flatShading: true, roughness: 0.9 }),
  );
  pole.position.y = poleHeight / 2;
  pole.castShadow = true;

  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 6, 4),
    new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.6,
      flatShading: true,
      roughness: 0.5,
    }),
  );
  knob.position.y = poleHeight + 0.02;

  const geo = new THREE.PlaneGeometry(CLOTH_W, CLOTH_H, SEGS, 1);
  // 旗面从杆顶向一侧展开：把几何体整体右移半个宽
  geo.translate(CLOTH_W / 2, 0, 0);
  const cloth = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.22,
      side: THREE.DoubleSide,
      flatShading: true,
      roughness: 0.8,
    }),
  );
  cloth.position.set(0, poleHeight - CLOTH_H * 0.55, 0);
  cloth.castShadow = true;

  const base = Float32Array.from(geo.attributes['position']!.array as Float32Array);

  group.add(pole, knob, cloth);

  const pos = geo.attributes['position'] as THREE.BufferAttribute;
  return {
    group,
    update(time: number) {
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x0 = base[i]!;
        const y0 = base[i + 1]!;
        // 越靠旗尾摆得越大；两个不同频率叠一下，免得像一条规则的正弦
        const k = x0 / CLOTH_W;
        const wave = Math.sin(time * 5.2 - k * 4.4) * 0.13 + Math.sin(time * 2.1 - k * 2.0) * 0.06;
        arr[i + 2] = wave * k;
        // 布面在风口会略微上下抖，顺手带一点
        arr[i + 1] = y0 + Math.cos(time * 3.3 - k * 3.1) * 0.02 * k;
      }
      pos.needsUpdate = true;
    },
  };
}

/** 每栋楼挂旗的位置与杆高（相对占地中心，单位=格）。 */
export function bannerSpot(kind: string, cols: number, rows: number): { x: number; z: number; h: number } {
  // 杆高必须**高过屋顶**：模型放大 1.75 倍之后屋顶大约 2.8，杆矮了整面旗都会被楼挡住
  const x = cols * 0.42;
  const z = rows * 0.42;
  switch (kind) {
    case 'core':
      return { x: -x, z: -z, h: 3.6 };
    case 'mill':
      return { x, z, h: 3.2 };
    case 'barracks':
      return { x: -x, z, h: 3.0 };
    case 'cannonTower':
      return { x: -x, z, h: 2.7 };
    default:
      return { x: -x, z: -z, h: 2.9 };
  }
}
