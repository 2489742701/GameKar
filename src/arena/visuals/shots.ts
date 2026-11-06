/**
 * 飞行中的弹丸：箭、炮弹、法术弹，以及它们后面的尾巴。
 *
 * 三条硬约束（都是踩过的坑）：
 * 1. **几何体和材质全场共用**：射手一多，每帧都在造箭，逐个 dispose 会反复重建几何体；
 * 2. 尾巴也用**几何体**而不是粒子 —— `BattleFx` 的烟池只有 64 团，几十发弹会把它吃光；
 * 3. 移除弹丸时，共用的几何/材质**不能 dispose**（尾巴那几件带 `userData.trail` 标记，跳过）。
 */

import * as THREE from 'three';

/** 炮口离地高度（格）：和模型对得上（×BUILDING_SCALE 之后的塔顶 / 台面 / 车头）。 */
/** source → 炮口离地高度：大本营水晶顶在 2.28 + 0.62/2 ≈ 2.6（models.coreModel）。 */
export const MUZZLE_Y = { arrowTower: 5.6, cannonTower: 2.55, siege: 0.95, ballista: 1.15, unit: 1.1, core: 2.6 } as const;

/** 一支箭：杆 + 三角箭头 + 两片尾羽，沿 +Z 指向前方。 */
const ARROW_GEO = {
  shaft: new THREE.BoxGeometry(0.035, 0.035, 0.5),
  head: new THREE.ConeGeometry(0.06, 0.14, 4),
  tail: new THREE.BoxGeometry(0.12, 0.02, 0.14),
};
const ARROW_MAT = {
  wood: new THREE.MeshStandardMaterial({ color: 0x8a5f2c, flatShading: true, roughness: 0.9 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xd9d9e3, flatShading: true, roughness: 0.4 }),
  fletch: new THREE.MeshStandardMaterial({ color: 0xe6d8b4, flatShading: true, roughness: 0.9 }),
};

export function makeArrow(): THREE.Group {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(ARROW_GEO.shaft, ARROW_MAT.wood);
  const head = new THREE.Mesh(ARROW_GEO.head, ARROW_MAT.steel);
  head.rotation.x = Math.PI / 2;
  head.position.z = 0.31;
  const tail = new THREE.Mesh(ARROW_GEO.tail, ARROW_MAT.fletch);
  tail.position.z = -0.22;
  group.add(shaft, head, tail, makeTrail('arrow'));
  return group;
}

/**
 * 弹丸的尾巴（2026-11-02 用户："射出的炮弹还有箭矢，要不给他们后面加一个尾巴"）。
 *
 * 朝向和弹丸本体同一套约定：
 * - 箭沿 +Z 飞 ⇒ `rotation.x = +π/2`，锥尖落在弹丸上、锥底拖在 -Z
 * - 炮弹 / 法术沿 +X 飞 ⇒ `rotation.z = -π/2`
 *
 * 半透明 + 不写深度：写深度会在弹丸穿过自己尾巴时把它切掉一块。
 */
const TRAIL_GEO = {
  arrow: new THREE.ConeGeometry(0.04, 1.05, 5),
  smoke: new THREE.ConeGeometry(0.15, 1.25, 6),
  ember: new THREE.ConeGeometry(0.06, 1.0, 5),
  magic: new THREE.ConeGeometry(0.085, 0.95, 5),
};
const TRAIL_MAT = {
  arrow: new THREE.MeshBasicMaterial({ color: 0xf6ead0, transparent: true, opacity: 0.42, depthWrite: false }),
  smoke: new THREE.MeshBasicMaterial({ color: 0x6a6055, transparent: true, opacity: 0.24, depthWrite: false }),
  ember: new THREE.MeshBasicMaterial({
    color: 0xffa845,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  magic: new THREE.MeshBasicMaterial({
    color: 0x74e0ff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
};

function makeTrail(ammo: 'arrow' | 'cannon' | 'magic'): THREE.Group {
  const group = new THREE.Group();
  group.userData['trail'] = true;
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, z: number, rot: THREE.Euler) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0, z);
    mesh.rotation.copy(rot);
    // 几何/材质全场共用，移除时不能 dispose（见 syncShots 里那段）
    mesh.userData['trail'] = true;
    group.add(mesh);
  };
  if (ammo === 'arrow') {
    add(TRAIL_GEO.arrow, TRAIL_MAT.arrow, 0, -0.52, new THREE.Euler(Math.PI / 2, 0, 0));
  } else if (ammo === 'magic') {
    add(TRAIL_GEO.magic, TRAIL_MAT.magic, -0.47, 0, new THREE.Euler(0, 0, -Math.PI / 2));
  } else {
    // 炮弹：外面一层浅灰的烟、里面一条亮橙的尾焰
    // （只做深色烟的话，在绿草地上是一根看不见的灰棍子 —— 实测第一版就是这样）
    add(TRAIL_GEO.smoke, TRAIL_MAT.smoke, -0.62, 0, new THREE.Euler(0, 0, -Math.PI / 2));
    add(TRAIL_GEO.ember, TRAIL_MAT.ember, -0.5, 0, new THREE.Euler(0, 0, -Math.PI / 2));
  }
  return group;
}

/** 炮弹 / 法术弹：一颗低多边形球。尾巴挂在 `-X`（这两个弹种的"前方"是 +X）。 */
export function makeBall(
  radius: number,
  color = 0x1a1d24,
  emissive = 0x000000,
  ammo: 'cannon' | 'magic' = 'cannon',
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 6, 4),
    new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: emissive ? 1.4 : 0,
      flatShading: true,
      roughness: 0.6,
    }),
  );
  mesh.castShadow = emissive === 0;
  mesh.add(makeTrail(ammo));
  return mesh;
}
