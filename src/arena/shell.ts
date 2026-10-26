/**
 * 外墙的"活"部分 —— 把 `models.ts` 给的墙面片合成一张网格，受伤时整块摘掉。
 *
 * 为什么合成一张：一栋楼 30–50 块板，一块一个 Mesh 就是 50 次 draw call × 场上十几栋。
 * 合成之后一栋楼只有 1 次；拆的时候重建顶点（只在掉血那几帧发生，最多 5 次）。
 *
 * 洞的形状 = 面片的轮廓：从一块种子板开始，每次摘掉离它最近的一块，
 * 于是洞口是**连成一片**的，而不是均匀撒了一墙的洞。
 */

import * as THREE from 'three';
import type { Random } from '@engine/math/Random';
import type { ShellPanel } from './models';

/** 一栋楼的外墙网格。 */
export class WallShell {
  readonly mesh: THREE.Mesh;
  private panels: ShellPanel[];

  constructor(panels: readonly ShellPanel[]) {
    this.panels = [...panels];
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.92,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'wall-shell';
    this.rebuild();
  }

  get count(): number {
    return this.panels.length;
  }

  /** 还剩哪些面片（只读，测试与调试用）。 */
  get remaining(): readonly ShellPanel[] {
    return this.panels;
  }

  /**
   * 从墙上崩掉 `count` 块（就近成片）。
   *
   * 优先从**镜头这一侧**（z > 0）起洞：默认机位看不到背面的破洞，
   * 但玩家转镜头时背面也得是完整的，所以只影响"先从哪儿开始"。
   * 返回被摘掉的板，调用方拿它们去做下落动画。
   */
  breach(count: number, rnd: Random): ShellPanel[] {
    if (this.panels.length === 0) return [];
    const visible = this.panels.filter((p) => p.z > 0);
    const pool = rnd.chance(0.75) && visible.length > 0 ? visible : this.panels;
    const seed = pool[rnd.int(0, pool.length)]!;

    const removed: ShellPanel[] = [];
    let cursor = seed;
    while (removed.length < count && this.panels.length > 0) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < this.panels.length; i++) {
        const p = this.panels[i]!;
        const d = (p.x - cursor.x) ** 2 + (p.y - cursor.y) ** 2 + (p.z - cursor.z) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best < 0) break;
      cursor = this.panels[best]!;
      removed.push(cursor);
      this.panels.splice(best, 1);
    }
    this.rebuild();
    return removed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  /** 把剩下的面片合成一张带顶点色的网格（flat shading，每块板自己的色调）。 */
  private rebuild(): void {
    const position: number[] = [];
    const normal: number[] = [];
    const color: number[] = [];
    const tint = new THREE.Color();
    const matrix = new THREE.Matrix4();

    for (const p of this.panels) {
      // 一块板就是一个 box：旋转（绕 y）→ 平移到墙上
      const src = new THREE.BoxGeometry(p.w, p.h, p.t);
      matrix.makeRotationY(p.yaw);
      matrix.setPosition(p.x, p.y, p.z);
      src.applyMatrix4(matrix);
      // **必须转成非索引**：BoxGeometry 是 24 顶点 + 36 索引，只抄顶点会把角点
      // 当成连续三角形 → 塔身上凭空出现几道白色大叉（这个 bug 是看截图抓到的）。
      const geo = src.toNonIndexed();
      src.dispose();

      const pos = geo.getAttribute('position');
      const nrm = geo.getAttribute('normal');
      tint.set(p.color);
      for (let i = 0; i < pos.count; i++) {
        position.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        normal.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        color.push(tint.r, tint.g, tint.b);
      }
      geo.dispose();
    }

    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    next.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    next.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
    next.computeBoundingSphere();

    this.mesh.geometry.dispose();
    this.mesh.geometry = next;
  }
}
