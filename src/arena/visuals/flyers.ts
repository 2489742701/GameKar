/**
 * 三架飞行器的 3D 模型（2026-11-07，设计文档 D 节）。
 *
 * ⚠️ 用户 07:45 纠正：**热气球是热气球，达芬奇飞行器是飞行器，两者都要**；
 * 第二份 HTML 的机械扑翼机又是第三个单位（轰炸机）。这里三份模型互相独立，
 * 不是把哪一份「简化成热气球」。
 *
 * - 热气球：球囊 + 吊篮 + 吊绳（本项目自建）；
 * - 空气螺旋机：第一份 HTML（尖锥座舱 + 旋转螺旋帆）简化；
 * - 扑翼轰炸机：第二份 HTML（龙骨 + 开放座舱 + 双三角翼 + 燕尾 + 前螺旋桨）简化。
 *
 * 分段数/骨架数按战场 1.6 格高裁剪，球囊与帆布用玩家花色主色。
 */
import * as THREE from 'three';

/**
 * 飞行单位的**高度与体型**（2026-11-07 用户："所有飞行单位的飞行高度太小了，
 * 它们的大小也太小了，可以稍微大一点。尤其是热气球可以更大一点"）。
 *
 * 原来 `FLY_HEIGHT=1.25` 格 —— 比民居（约 3 格）还矮，俯视下看着像贴地滑。
 * 中午提到 2.6，深夜用户又说"空军还是有点低了，可以再高一点" ⇒ **3.8 格**，
 * 明显压在屋顶线上方，俯视下和地面单位彻底分层。体型倍率也集中在这张表，
 * `ArenaApp` 只读它，不在三处各写一个数。热气球给最大倍率。
 */
export const FLYER_STYLE = {
  height: 3.8,
  scale: { balloon: 1.5, airscrew: 1.05, bomber: 0.45 },
  shadow: { balloon: 1.5, airscrew: 1.2, bomber: 1.45 },
} as const;

/**
 * 机头朝向：模型的前方是**局部 +Z**（扑翼机的前桨在 z=+3.95、燕尾在 z=-3.8），
 * 而逻辑层 `u.aim = atan2(dz, dx)` 是 XZ 平面角（0 = 朝 +X）。
 * `R_y(θ)` 把 +Z 转到 `(sin θ, cos θ)`，要等于 `(cos aim, sin aim)` ⇒ `θ = π/2 − aim`。
 *
 * ⚠️ 别抄攻城车那套 `rotation.y = -aim`：车头是沿 **+X** 建的（炮口 x=+0.72），
 * 两个模型的前向轴差 90°，混用就会"歪过来滑"（2026-11-07 用户抓到的 bug）。
 */
export const flyerYaw = (aim: number): number => Math.PI / 2 - aim;

export interface FlyerModel {
  group: THREE.Group;
  /** 每帧转动的转子（螺旋帆 / 前螺旋桨） */
  rotor?: THREE.Object3D;
  rotorAxis?: 'y' | 'z';
  /** 轻微颤动的翼（扑翼机） */
  wings?: THREE.Object3D[];
  /** 闪白用的材质（每架独立实例，别共享） */
  mats: THREE.MeshStandardMaterial[];
}

const wood = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: 0xa9784a, roughness: 0.8, flatShading: true });
const darkWood = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: 0x6d4a2c, roughness: 0.86, flatShading: true });
const canvasOf = (accent: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: accent, roughness: 0.9, side: THREE.DoubleSide, flatShading: true });

/** 两点之间的细木杆（用户 HTML 里的 rod 工具，简化版）。 */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, seg = 6): THREE.Mesh {
  const dir = b.clone().sub(a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), seg), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return m;
}

/** 三角面片（帆布蒙皮）：顶点数组 3 个 Vector3。 */
function tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/** 螺旋帆布：radial 2 × angular 48、1.6 圈（原 HTML 是 12×280）。 */
function helix(rIn: number, rOut: number, turns: number, height: number, mat: THREE.Material): THREE.Mesh {
  const radial = 2, angular = 48;
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= radial; i++) {
    const r = rIn + (rOut - rIn) * (i / radial);
    for (let j = 0; j <= angular; j++) {
      const v = j / angular;
      const th = v * turns * Math.PI * 2;
      pos.push(r * Math.cos(th), v * height, r * Math.sin(th));
    }
  }
  const stride = angular + 1;
  for (let i = 0; i < radial; i++) {
    for (let j = 0; j < angular; j++) {
      const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

function collectMats(group: THREE.Group): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) out.push(m);
  });
  return out;
}

/** ① 热气球：球囊 + 吊篮 + 4 根吊绳 + 顶旗（自建，不是达芬奇飞行器）。 */
export function makeBalloon(accent: number): FlyerModel {
  const g = new THREE.Group();
  const w = wood(), d = darkWood(), sail = canvasOf(accent);
  /**
   * 球囊加大（用户："热气球好敷衍啊，气球大一点，下面有个小斗子"）：
   * 半径 0.7 → 1.0，纵向拉 1.18；斗子从 0.5 的小方块改成 0.66×0.42 的
   * 藤编吊篮（四角立柱 + 上下沿），吊绳也跟着拉长接到球囊底。
   */
  const envelope = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 12), sail);
  envelope.scale.set(1, 1.18, 1);
  envelope.position.y = 1.52;
  g.add(envelope);
  // 球囊竖向色筋：几条深色的细带，让"大球"不至于是一整块纯色
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(rod(
      new THREE.Vector3(Math.cos(a) * 0.99, 1.05, Math.sin(a) * 0.99),
      new THREE.Vector3(Math.cos(a) * 0.55, 2.62, Math.sin(a) * 0.55),
      0.018, d, 4,
    ));
  }
  const basket = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.42, 0.66), w);
  basket.position.y = 0.24;
  g.add(basket);
  // 斗子的四角立柱 + 上下沿（小斗子的"编"感）
  for (const sx of [-0.31, 0.31]) {
    for (const sz of [-0.31, 0.31]) {
      g.add(rod(new THREE.Vector3(sx, 0.06, sz), new THREE.Vector3(sx, 0.45, sz), 0.022, d, 4));
    }
  }
  for (const y of [0.06, 0.45]) {
    g.add(rod(new THREE.Vector3(-0.31, y, -0.31), new THREE.Vector3(0.31, y, -0.31), 0.02, d, 4));
    g.add(rod(new THREE.Vector3(-0.31, y, 0.31), new THREE.Vector3(0.31, y, 0.31), 0.02, d, 4));
    g.add(rod(new THREE.Vector3(-0.31, y, -0.31), new THREE.Vector3(-0.31, y, 0.31), 0.02, d, 4));
    g.add(rod(new THREE.Vector3(0.31, y, -0.31), new THREE.Vector3(0.31, y, 0.31), 0.02, d, 4));
  }
  for (const sx of [-0.26, 0.26]) {
    for (const sz of [-0.26, 0.26]) {
      g.add(rod(new THREE.Vector3(sx, 0.45, sz), new THREE.Vector3(sx * 0.62, 1.02, sz * 0.62), 0.018, d, 4));
    }
  }
  const flag = tri(new THREE.Vector3(0, 2.78, 0), new THREE.Vector3(0.42, 2.64, 0), new THREE.Vector3(0, 2.5, 0), d);
  g.add(flag);
  g.scale.setScalar(FLYER_STYLE.scale.balloon);
  return { group: g, mats: collectMats(g) };
}

/** ② 达芬奇空气螺旋机：第一份 HTML 简化（尖锥座舱 + 螺旋帆 + 转子）。 */
export function makeAirscrew(accent: number): FlyerModel {
  const g = new THREE.Group();
  const w = wood(), d = darkWood(), sail = canvasOf(accent);
  const cabin = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.8, 10), d);
  cabin.rotation.z = Math.PI; // 尖朝下
  cabin.position.y = 0.44;
  g.add(cabin);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.07, 10), w);
  deck.position.y = 0.86;
  g.add(deck);
  for (let i = 0; i < 4; i++) {
    const th = (i / 4) * Math.PI * 2;
    g.add(rod(new THREE.Vector3(Math.cos(th) * 0.16, 0.14, Math.sin(th) * 0.16),
      new THREE.Vector3(Math.cos(th) * 0.46, 0.82, Math.sin(th) * 0.46), 0.022, w, 5));
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.25, 8), w);
  mast.position.y = 1.5;
  g.add(mast);
  const rotor = new THREE.Group();
  rotor.position.y = 0.92;
  rotor.add(helix(0.12, 0.9, 1.6, 0.9, sail));
  for (let i = 0; i < 6; i++) {
    const t = i / 6, th = t * 1.6 * Math.PI * 2, y = t * 0.9;
    rotor.add(rod(new THREE.Vector3(0.12 * Math.cos(th), y, 0.12 * Math.sin(th)),
      new THREE.Vector3(0.9 * Math.cos(th), y, 0.9 * Math.sin(th)), 0.018, d, 5));
  }
  g.add(rotor);
  g.scale.setScalar(FLYER_STYLE.scale.airscrew);
  return { group: g, rotor, rotorAxis: 'y', mats: collectMats(g) };
}

/** ③ 达芬奇机械扑翼机·轰炸机：第二份 HTML 简化（开放座舱 + 双三角翼 + 燕尾 + 前桨）。 */
export function makeBomber(accent: number): FlyerModel {
  const g = new THREE.Group();
  const w = wood(), d = darkWood(), sail = canvasOf(accent);
  // 龙骨
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 7.8, 8), w);
  beam.rotation.x = Math.PI / 2;
  beam.position.z = -0.5;
  g.add(beam);
  // 开放座舱：框 + 4 根支柱 + 脚踏轮
  const seat = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.045, 6, 20), d);
  seat.rotation.x = Math.PI / 2;
  seat.position.set(0, -0.45, 0.4);
  g.add(seat);
  for (const [x, z] of [[-0.6, 0], [0.6, 0], [0, -0.6], [0, 0.6]] as [number, number][]) {
    g.add(rod(new THREE.Vector3(x, -0.45, z + 0.4), new THREE.Vector3(0, 0.2, 0.4), 0.025, w, 5));
  }
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.03, 6, 18), w);
  wheel.position.set(0, -0.35, 1.0);
  g.add(wheel);
  // 双三角翼（帆布 + 前缘骨）
  const wings: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const wing = new THREE.Group();
    const A = new THREE.Vector3(0, 0.2, 0.8), B = new THREE.Vector3(1.8 * side, 0.5, 0.6),
      C = new THREE.Vector3(4.5 * side, 1.2, -0.2), D = new THREE.Vector3(4.2 * side, 1.1, -1.6),
      E = new THREE.Vector3(1.5 * side, 0.3, -1.8), F = new THREE.Vector3(0, 0.1, -1.2);
    wing.add(tri(A, B, E, sail), tri(A, E, F, sail), tri(B, C, D, sail), tri(B, D, E, sail));
    wing.add(rod(A, B, 0.045, d, 6), rod(B, C, 0.04, d, 6), rod(F, E, 0.035, w, 6), rod(C, D, 0.025, w, 6));
    g.add(wing);
    wings.push(wing);
  }
  // 燕尾
  const tail = new THREE.Group();
  tail.position.z = -3.8;
  const L = new THREE.Vector3(-1.4, 0.2, -1.2), R = new THREE.Vector3(1.4, 0.2, -1.2), O = new THREE.Vector3(0, 0, 0);
  tail.add(rod(O, L, 0.04, d, 6), rod(O, R, 0.04, d, 6));
  tail.add(tri(O, L, new THREE.Vector3(-0.5, 0.2, -0.6), sail), tri(O, new THREE.Vector3(0.5, 0.2, -0.6), R, sail));
  g.add(tail);
  // 前部螺旋桨（两片三角叶，绕 z 转）
  const rotor = new THREE.Group();
  rotor.position.set(0, 0.1, 3.95);
  const mount = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.03, 6, 18), w);
  mount.rotation.y = Math.PI / 2;
  rotor.add(mount);
  for (let i = 0; i < 2; i++) {
    const blade = new THREE.Group();
    blade.rotation.z = i * Math.PI;
    blade.add(tri(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.15, 0.8, 0.1), new THREE.Vector3(0.05, 1.2, 0.2), sail));
    blade.add(tri(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, 1.2, 0.2), new THREE.Vector3(-0.1, 0.6, 0.1), sail));
    rotor.add(blade);
  }
  g.add(rotor);
  g.scale.setScalar(FLYER_STYLE.scale.bomber); // 原翼展 9 格 → 约 4 格
  return { group: g, rotor, rotorAxis: 'z', wings, mats: collectMats(g) };
}
