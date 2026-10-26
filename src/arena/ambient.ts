/**
 * 战场浮尘 —— 一层很淡的"空气"，不是特效主角。
 *
 * 开火/崩墙/掉渣才是粒子该抢眼的地方；这一层只负责让静止的画面不像一张贴图。
 * 所以做成一个 `Points`（一次 draw call、不写深度、不投/收阴影），
 * 几十个像素小点在低空横向漂，出了场地就从另一边绕回来 —— 没有生成/销毁，没有 GC。
 */

import * as THREE from 'three';
import { Random } from '@engine/math/Random';

export class AmbientDust {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  /** 每个点的水平速度（x, z），格/秒 */
  private readonly drift: Float32Array;
  private readonly cols: number;
  private readonly rows: number;

  constructor(cols: number, rows: number, count = 90, seed = 4242) {
    this.cols = cols;
    this.rows = rows;
    this.positions = new Float32Array(count * 3);
    this.drift = new Float32Array(count * 2);

    const rnd = new Random(seed);
    for (let i = 0; i < count; i++) {
      this.positions[i * 3] = rnd.float(0.5, cols - 0.5);
      this.positions[i * 3 + 1] = rnd.float(0.7, 2.6);
      this.positions[i * 3 + 2] = rnd.float(0.5, rows - 0.5);
      this.drift[i * 2] = rnd.float(-0.12, 0.12);
      this.drift[i * 2 + 1] = rnd.float(-0.09, 0.09);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xf2e6c4,
      // 正交相机下 sizeAttenuation 会把点缩到看不见；这里直接用**屏幕像素**大小
      size: 2.4,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.name = 'ambient-dust';
  }

  update(dt: number): void {
    const { positions, drift, cols, rows } = this;
    for (let i = 0; i < drift.length / 2; i++) {
      let x = positions[i * 3]! + drift[i * 2]! * dt;
      let z = positions[i * 3 + 2]! + drift[i * 2 + 1]! * dt;
      // 绕回：右边出去左边回来（不做生成/销毁，数组长度永远不变）
      if (x < 0) x += cols;
      else if (x > cols) x -= cols;
      if (z < 0) z += rows;
      else if (z > rows) z -= rows;
      positions[i * 3] = x;
      positions[i * 3 + 2] = z;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
