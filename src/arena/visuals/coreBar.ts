/**
 * 大本营的**世界空间悬浮血条**。
 *
 * 用户 2026-11-06："蓝方/红方大本营还有血条全部关掉……大本营就是受击的时候，
 * 可以在大本营后面一段距离，然后悬浮血条。"
 *
 * 所以它不是 HUD：挂在 3D 场景里、跟着大本营走，**满血不显示**，掉血才浮出来。
 * 位置由调用方给（楼顶上方 1.5 格），这里只造几何。
 *
 * 两个细节：
 * - `depthTest: false` + 高 `renderOrder`：血条不能被自己的屋顶、前面的兵挡住；
 * - 每帧 `quaternion.copy(camera.quaternion)`：正交相机转视角时血条始终正对屏幕（billboard）。
 */

import * as THREE from 'three';

export interface CoreBar {
  group: THREE.Group;
  fill: THREE.Mesh;
  track: THREE.Mesh;
  width: number;
}

export function makeCoreBar(color: number): CoreBar {
  const width = 3.2;
  const group = new THREE.Group();
  group.name = 'core-hp';

  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.14, 0.34),
    new THREE.MeshBasicMaterial({
      color: 0x120b06,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(width, 0.26),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.96,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  fill.position.z = 0.01;
  track.renderOrder = 30;
  fill.renderOrder = 31;
  group.add(track, fill);
  group.visible = false; // 满血不挂条
  return { group, fill, track, width };
}

/**
 * 掉血时把条缩到对应比例；`position.x` 补上中心缩放，让左端固定不动。
 * `alpha` 给「挨打后淡出」用：1 = 刚打中，0 = 该收起来了。
 */
export function updateCoreBar(bar: CoreBar, frac: number, alpha = 1): void {
  const k = Math.max(0, Math.min(1, frac));
  bar.fill.scale.x = Math.max(0.001, k);
  bar.fill.position.x = -bar.width * 0.5 * (1 - k);
  // 掉到 30% 以下翻红，和楼顶小血条同一套信号
  (bar.fill.material as THREE.MeshBasicMaterial).color.setHex(k < 0.3 ? 0xff6b6b : 0x8db6ff);
  (bar.fill.material as THREE.MeshBasicMaterial).opacity = 0.96 * alpha;
  (bar.track.material as THREE.MeshBasicMaterial).opacity = 0.82 * alpha;
}
