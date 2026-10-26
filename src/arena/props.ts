/**
 * 对战模式的旗帜 —— 阵营色只出现在这一小片布上（不在地上涂色块）。
 *
 * 布面用几段正弦摆动（每帧改顶点，不用着色器）：核心、兵营、箭塔、炮塔、磨坊各一面，
 * 落点由 `models.ts` 的 `ARENA_FLAGS` 给（底部/杆高都按模型自身高度配）。
 */

import * as THREE from 'three';
import type { Side } from './config';
import { sideColor } from './theme';

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
export function makeBanner(side: Side, pole = 0.85, width = 0.74, height = 0.78): Banner {
  const group = new THREE.Group();
  const tint = sideColor(side);

  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.055, pole, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4526, flatShading: true, roughness: 0.9 }),
  );
  mast.position.y = pole / 2;
  mast.castShadow = true;

  const bar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, width * 1.1, 6),
    new THREE.MeshStandardMaterial({ color: 0x9a6b3f, flatShading: true, roughness: 0.9 }),
  );
  bar.rotation.z = Math.PI / 2;
  bar.position.y = pole;

  // 杆顶一颗金球：旗杆太细，远看只剩一块布，有个亮点才知道那是"杆"
  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 6, 4),
    new THREE.MeshStandardMaterial({
      color: 0xc8a24c,
      emissive: 0xc8a24c,
      emissiveIntensity: 0.35,
      flatShading: true,
      roughness: 0.5,
    }),
  );
  knob.position.y = pole + 0.04;
  knob.castShadow = true;

  const geo = new THREE.PlaneGeometry(width, height, 3, 4);
  geo.translate(0, -height / 2, 0);
  const cloth = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
      flatShading: true,
      roughness: 0.85,
    }),
  );
  cloth.position.y = pole;
  cloth.castShadow = true;

  const base = Float32Array.from(geo.attributes['position']!.array as Float32Array);
  const pos = geo.attributes['position'] as THREE.BufferAttribute;

  group.add(mast, bar, knob, cloth);

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

