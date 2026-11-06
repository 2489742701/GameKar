/**
 * 施工脚手架 —— 纯几何，不带任何玩法状态。
 *
 * 为什么单独一个文件：它只在"楼正在垒"的那几秒存在（`b.build < 1`），
 * 和 `ArenaApp` 里那堆输入/相机/同步逻辑不是一类东西；
 * 尺寸单位是**格**（调用方把它直接放进世界坐标，不跟 `BUILDING_SCALE` 缩放）。
 */

import * as THREE from 'three';

/** 脚手架的木头材质：全场共用（几何每栋自己造，材质不重复）。 */
const SCAFFOLD_MAT = new THREE.MeshStandardMaterial({ color: 0x8a6a3f, roughness: 0.95, flatShading: true });

/**
 * 施工脚手架：四角立柱 + 三层横梁 + 两根斜撑。
 *
 * @param cols 占地宽（格）
 * @param rows 占地深（格）
 * @param height 楼体最终高度（世界单位），脚手架按它的 92% 建 —— 完工时略低于屋顶
 */
export function makeScaffold(cols: number, rows: number, height: number): THREE.Group {
  const g = new THREE.Group();
  const w = cols + 0.6;
  const d = rows + 0.6;
  const h = Math.max(1.6, height * 0.92);
  const post = 0.07;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(post, h, post), SCAFFOLD_MAT);
      m.position.set((sx * w) / 2, h / 2, (sz * d) / 2);
      m.castShadow = true;
      g.add(m);
    }
  }
  for (const y of [h * 0.34, h * 0.67, h * 0.99]) {
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 0.06), SCAFFOLD_MAT);
      m.position.set(0, y, (sz * d) / 2);
      m.castShadow = true;
      g.add(m);
    }
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, d), SCAFFOLD_MAT);
      m.position.set((sx * w) / 2, y, 0);
      m.castShadow = true;
      g.add(m);
    }
  }
  // 正面两根斜撑：不加的话读起来像个围栏，不像工地
  const diag = Math.hypot(w * 0.64, h * 0.66);
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, diag, 0.05), SCAFFOLD_MAT);
    m.position.set(sx * w * 0.18, h * 0.34, d / 2);
    m.rotation.z = sx * Math.atan2(w * 0.64, h * 0.66);
    g.add(m);
  }
  return g;
}

/** 把一棵子树的几何体都释放掉（材质是共享的，不动）。 */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}
