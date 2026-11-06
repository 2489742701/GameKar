/**
 * 小人脚下的**贴地黑影**（2026-11-06 用户："给他们一个影子，他们自己的
 * 全黑贴图，倒在地上那种感觉"）。
 *
 * 像素小人是 billboard，不参与阴影贴图；这是画在地面上的椭圆黑影贴片：
 * 中心最黑、边缘渐隐（radial gradient），贴地 0.02 防 z-fight。
 * 几何体和贴图全场共用，每个单位只持有一个薄 mesh；死亡时 removeFromParent。
 */
import * as THREE from 'three';

let shared: { geo: THREE.PlaneGeometry; tex: THREE.CanvasTexture } | null = null;

function sharedAssets(): { geo: THREE.PlaneGeometry; tex: THREE.CanvasTexture } {
  if (shared) return shared;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 3, 32, 32, 30);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.65, 'rgba(0,0,0,0.32)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  shared = {
    geo: new THREE.PlaneGeometry(1, 1),
    tex: new THREE.CanvasTexture(canvas),
  };
  return shared;
}

/** 一片贴地影子：w=宽（左右），d=深（前后）。单位宽度的 1.3 倍左右最像。 */
export function makeShadow(w: number, d: number): THREE.Mesh {
  const { geo, tex } = sharedAssets();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.set(w, d, 1);
  mesh.renderOrder = 2;
  return mesh;
}
