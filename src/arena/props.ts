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

export interface Banner {
  group: THREE.Group;
  /** 每帧喂时间，布面自己摆 */
  update(time: number): void;
}

/**
 * 挂在墙上的**竖旗**：一根横杆钉在檐口，布从杆上往下垂。
 * 顶边钉死（摆幅 = 0），越靠旗尾摆得越大；横向 3 段、纵向 6 段，够看出波浪又不费顶点。
 *
 * 用户第二次改口："旗帜是竖的，挂在上面的，挂在墙上面的，从上往下的旗帜" ——
 * 之前那版是"杆子立在地上、布朝一侧飘"，那是旗杆旗，不是挂在墙上的家族旗。
 */
export function makeBanner(side: Side, pole = 0.85, width = 0.6, height = 0.62): Banner {
  const group = new THREE.Group();
  const tint = sideColor(side);

  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.032, pole, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4526, flatShading: true, roughness: 0.9 }),
  );
  mast.position.y = pole / 2;
  mast.castShadow = true;

  const bar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.024, 0.024, width * 1.15, 6),
    new THREE.MeshStandardMaterial({ color: 0x4a3a26, flatShading: true, roughness: 0.9 }),
  );
  bar.rotation.z = Math.PI / 2;
  bar.position.y = pole;

  const geo = new THREE.PlaneGeometry(width, height, 3, 4);
  geo.translate(0, -height / 2, 0);
  const cloth = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.24,
      side: THREE.DoubleSide,
      flatShading: true,
      roughness: 0.85,
    }),
  );
  cloth.position.y = pole;
  cloth.castShadow = true;

  const base = Float32Array.from(geo.attributes['position']!.array as Float32Array);
  const pos = geo.attributes['position'] as THREE.BufferAttribute;

  group.add(mast, bar, cloth);

  return {
    group,
    update(time: number) {
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x0 = base[i]!;
        const y0 = base[i + 1]!;
        const k = Math.min(1, Math.max(0, -y0 / height));
        arr[i + 2] = Math.sin(time * 3.1 + x0 * 2.4 + k * 2.6) * 0.08 * k;
        arr[i] = x0 + Math.sin(time * 1.6 + k * 2.0) * 0.02 * k;
      }
      pos.needsUpdate = true;
    },
  };
}

/**
 * 每栋楼挂旗的位置：贴在前墙（+z 一侧，正对镜头那面）上，旗顶高度按楼高给。
 * 位置/高度都用**格**，因为调用方会把它放进反向缩放的 ui 组里。
 */
export function bannerSpot(kind: string, cols: number, rows: number): { x: number; z: number; base: number; pole: number } {
  const x = cols * 0.26;
  const z = -rows * 0.22;
  switch (kind) {
    case 'core':
      return { x: -x, z, base: 4.2, pole: 0.95 };
    case 'mill':
      return { x, z, base: 3.5, pole: 0.9 };
    case 'barracks':
      return { x, z, base: 2.7, pole: 0.85 };
    case 'cannonTower':
      return { x: -x, z, base: 2.05, pole: 0.8 };
    default:
      return { x: -x, z, base: 4.2, pole: 0.9 };
  }
}
