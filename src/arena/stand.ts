/**
 * 竞技场的围墙、看台、帆布、角塔 —— 把 42×20 的战场框成"一个场地"。
 *
 * ★ 2026-11-06 用户澄清的"看台会消失"：
 * 不是隐藏某个面，而是**整段看台随镜头方位显隐**——
 * 「玩家在左边，左边的看台就消失；玩家面对右侧，右侧的看台消失、左侧重新显示」。
 *
 * 所以三段看台（左 / 右 / 远）各自是独立的 Group，每帧按相机 yaw 判断"哪一段离镜头最近"，
 * 把那**一整段**（台阶 + 座位 + 帆布 + 撑杆）藏掉，另外两段照常显示。
 * 墙与角塔是共用的、很矮，不挡视线，所以不跟着藏。
 *
 * 其余决定：
 * 1. 相机站在 +z 往后退 ⇒ z 越大离镜头越近（屏幕下方），所以近侧本来就不建墙；
 * 2. 朝外的面不渲染（六面材质数组 + `bake()` 跳过那些三角形），是"剖开的模型"效果；
 * 3. 看台 4 级 × 0.7 = 2.8 格，比 1.15 的城墙高；帆布是两色相间的布条；
 * 4. 同色几何按段烤成一张，整圈只有十几次 draw call。
 */

import * as THREE from 'three';

export interface StandOptions {
  cols: number;
  rows: number;
  baseY: number;
  blue: number;
  red: number;
}

export interface ArenaStand {
  group: THREE.Group;
  /** 每帧喂相机 yaw（度）：把离镜头最近的那一段看台整段藏掉 */
  update(yawDeg: number): void;
  /** 当前藏的是哪一段（调试面板 / 截图脚本读） */
  readonly hidden: string;
}

const WALL_H = 1.15;
const WALL_T = 0.75;
const STEP_H = 0.7;
const STEP_D = 0.95;
const STEPS = 4;

const FACE = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 } as const;
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

interface Buckets {
  stone: THREE.Mesh[];
  wood: THREE.Mesh[];
  seat: THREE.Mesh[];
  canvasA: THREE.Mesh[];
  canvasBlue: THREE.Mesh[];
  canvasRed: THREE.Mesh[];
  pole: THREE.Mesh[];
}

interface Mats {
  stone: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  seat: THREE.MeshStandardMaterial;
  canvasA: THREE.MeshStandardMaterial;
  canvasBlue: THREE.MeshStandardMaterial;
  canvasRed: THREE.MeshStandardMaterial;
  pole: THREE.MeshStandardMaterial;
}

const newBuckets = (): Buckets => ({
  stone: [], wood: [], seat: [], canvasA: [], canvasBlue: [], canvasRed: [], pole: [],
});

function openBox(
  w: number, h: number, d: number, solid: THREE.Material,
  hide: keyof typeof FACE | (keyof typeof FACE)[],
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mats: THREE.Material[] = [solid, solid, solid, solid, solid, solid];
  const hides = Array.isArray(hide) ? hide : [hide];
  for (const f of hides) mats[FACE[f]] = INVISIBLE;
  const mesh = new THREE.Mesh(geo, mats);
  // bake 会丢掉材质数组，所以隐藏信息记在这里，让 bake 跳过那些三角形
  mesh.userData['hideFace'] = hides.map((f) => FACE[f]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function bake(meshes: THREE.Mesh[], material: THREE.Material): THREE.Mesh | null {
  if (meshes.length === 0) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  for (const m of meshes) {
    m.updateMatrix();
    const src = m.geometry.clone();
    src.applyMatrix4(m.matrix);
    const geo = src.toNonIndexed();
    src.dispose();
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const hide = (m.userData['hideFace'] as number[] | undefined) ?? [];
    for (let i = 0; i < pos.count; i++) {
      // BoxGeometry 非索引 = 36 顶点，每面 6 个；命中隐藏面就跳过
      if (hide.length > 0 && hide.includes(Math.floor(i / 6))) continue;
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    }
    geo.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  const merged = new THREE.Mesh(geo, material);
  merged.castShadow = true;
  merged.receiveShadow = true;
  return merged;
}

/** 把一个桶里的七种材质各烤成一张几何，装进独立 Group —— 这样整段可以一键 visible=false。 */
function bakeSegment(b: Buckets, mats: Mats, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  const pairs: [keyof Buckets, THREE.Material][] = [
    ['stone', mats.stone], ['wood', mats.wood], ['seat', mats.seat],
    ['canvasA', mats.canvasA], ['canvasBlue', mats.canvasBlue], ['canvasRed', mats.canvasRed],
    ['pole', mats.pole],
  ];
  for (const [key, material] of pairs) {
    const one = bake(b[key], material);
    if (one) g.add(one);
  }
  return g;
}

/** 相机 yaw → 哪一段离镜头最近。yaw=0 在 +z、90 在 +x、180 在 -z、270 在 -x。 */
export function nearestSegment(yawDeg: number): 'front' | 'right' | 'back' | 'left' {
  const r = ((yawDeg % 360) + 360) % 360;
  if (r < 45 || r >= 315) return 'front'; // 近侧本来就没建看台
  if (r < 135) return 'right';
  if (r < 225) return 'back';
  return 'left';
}

export function buildStand(o: StandOptions): ArenaStand {
  const group = new THREE.Group();
  group.name = 'arena-stand';
  const { cols, rows, baseY } = o;

  const mats: Mats = {
    stone: new THREE.MeshStandardMaterial({ color: 0x7d7669, roughness: 0.96, flatShading: true }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5b4429, roughness: 0.95, flatShading: true }),
    seat: new THREE.MeshStandardMaterial({ color: 0x876a41, roughness: 0.94, flatShading: true }),
    canvasA: new THREE.MeshStandardMaterial({ color: 0xd9cba6, roughness: 0.98, flatShading: true }),
    canvasBlue: new THREE.MeshStandardMaterial({ color: 0x3f6fb5, roughness: 0.98, flatShading: true }),
    canvasRed: new THREE.MeshStandardMaterial({ color: 0xb5483f, roughness: 0.98, flatShading: true }),
    pole: new THREE.MeshStandardMaterial({ color: 0x6b4526, roughness: 0.9, flatShading: true }),
  };

  const common = newBuckets();
  const back = newBuckets();
  const left = newBuckets();
  const right = newBuckets();

  // ---------------------------------------------------------------- 三面城墙（共用，始终显示）
  {
    const w = cols + WALL_T * 2;
    const m = openBox(w, WALL_H, WALL_T, mats.stone, 'nz');
    m.position.set(cols / 2, baseY + WALL_H / 2, -WALL_T / 2);
    common.stone.push(m);
  }
  for (const side of [-1, 1] as const) {
    const m = openBox(WALL_T, WALL_H, rows + WALL_T, mats.stone, side < 0 ? 'nx' : 'px');
    m.position.set(side < 0 ? -WALL_T / 2 : cols + WALL_T / 2, baseY + WALL_H / 2, rows / 2);
    common.stone.push(m);
  }
  for (let c = 0.9; c < cols; c += 3) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.3, WALL_T * 0.9), mats.stone);
    m.position.set(c + 0.4, baseY + WALL_H + 0.15, -WALL_T / 2);
    common.stone.push(m);
  }

  // ---------------------------------------------------------------- 单段看台
  /**
   * `along` 决定长边朝哪条轴：后看台沿 x、侧看台沿 z。
   * 搞反了会有一条 20 格长的木条横插进场地（第一版就是这样，用户叫它"两个卡模型的墙垛"）。
   */
  const standSteps = (
    b: Buckets,
    len: number,
    at: (i: number) => { x: number; z: number },
    hide: keyof typeof FACE,
    along: 'x' | 'z',
    tint: 'canvasBlue' | 'canvasRed' | 'split',
  ): void => {
    const tintMat = tint === 'canvasBlue' ? mats.canvasBlue : mats.canvasRed;

    for (let i = 0; i < STEPS; i++) {
      const p = at(i);
      const w = along === 'x' ? len : STEP_D;
      const d = along === 'x' ? STEP_D : len;
      const box = openBox(w, STEP_H, d, mats.wood, hide);
      box.position.set(p.x, baseY + STEP_H * (i + 0.5), p.z);
      b.wood.push(box);

      const pad = new THREE.Mesh(
        along === 'x'
          ? new THREE.BoxGeometry(len - 0.2, 0.07, STEP_D * 0.6)
          : new THREE.BoxGeometry(STEP_D * 0.6, 0.07, len - 0.2),
        mats.seat,
      );
      pad.position.set(p.x, baseY + STEP_H * (i + 1) + 0.03, p.z);
      b.seat.push(pad);
    }

    /** 帆布：两色相间的布条（每 2 格一条），架在最后一排上方往场内探 */
    const canopyY = baseY + STEP_H * STEPS + 0.95;
    const stripes = Math.ceil(len / 2);
    const last = at(STEPS - 1);
    for (let s = 0; s < stripes; s++) {
      const stripLen = Math.min(2, len - s * 2);
      if (stripLen <= 0) break;
      const offset = -len / 2 + s * 2 + stripLen / 2;
      /**
       * 用户 2026-11-06：「看台怎么全部都是蓝色的？应该一半蓝色，中间隔断，另一半红色。」
       * 后看台传 'split'：条纹按中线（offset=0）分色，左半蓝白、右半红白。
       */
      const blue = offset < 0;
      const tintKey: 'canvasBlue' | 'canvasRed' =
        tint === 'split' ? (blue ? 'canvasBlue' : 'canvasRed') : tint;
      const stripeMat = s % 2 === 0
        ? mats.canvasA
        : tint === 'split' ? (blue ? mats.canvasBlue : mats.canvasRed) : tintMat;
      const strip = new THREE.Mesh(
        along === 'x'
          ? new THREE.BoxGeometry(stripLen, 0.09, 1.7)
          : new THREE.BoxGeometry(1.7, 0.09, stripLen),
        stripeMat,
      );
      strip.position.set(
        along === 'x' ? last.x + offset : last.x,
        canopyY,
        along === 'z' ? last.z + offset : last.z + 0.55,
      );
      if (along === 'x') strip.rotation.x = -0.14;
      else strip.rotation.z = 0.14;
      strip.castShadow = true;
      b[s % 2 === 0 ? 'canvasA' : tintKey].push(strip);
    }

    const poles = Math.max(2, Math.floor(len / 6));
    for (let p = 0; p < poles; p++) {
      const t = -len / 2 + (p + 0.5) * (len / poles);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.05, 6), mats.pole);
      post.position.set(
        along === 'x' ? last.x + t : last.x,
        baseY + STEP_H * STEPS + 0.52,
        along === 'z' ? last.z + t : last.z + 0.5,
      );
      b.pole.push(post);
    }
  };

  standSteps(back, cols + WALL_T * 2 + 2,
    (i) => ({ x: cols / 2, z: -(WALL_T + STEP_D / 2 + i * STEP_D) }),
    'nz', 'x', 'split');

  // 分色隔断：中线上一根石柱 + 米白顶帽，把蓝半场和红半场切开
  {
    const dividerZ = -(WALL_T + STEP_D * (STEPS - 0.5));
    const pier = new THREE.Mesh(new THREE.BoxGeometry(0.55, 3.6, 0.55), mats.stone);
    pier.position.set(cols / 2, baseY + 1.8, dividerZ);
    pier.castShadow = true;
    back.stone.push(pier);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.25, 0.85), mats.canvasA);
    cap.position.set(cols / 2, baseY + 3.7, dividerZ);
    back.canvasA.push(cap);
  }
  standSteps(left, rows + WALL_T,
    (i) => ({ x: -(WALL_T + STEP_D / 2 + i * STEP_D), z: rows / 2 }),
    'nx', 'z', 'canvasBlue');
  standSteps(right, rows + WALL_T,
    (i) => ({ x: cols + WALL_T + STEP_D / 2 + i * STEP_D, z: rows / 2 }),
    'px', 'z', 'canvasRed');

  // ---------------------------------------------------------------- 四个角的小塔（共用）
  const corners: { x: number; z: number; near: boolean; color: number }[] = [
    { x: -WALL_T, z: -WALL_T, near: false, color: o.blue },
    { x: cols + WALL_T, z: -WALL_T, near: false, color: o.red },
    { x: -WALL_T, z: rows + 2.6, near: true, color: o.blue },
    { x: cols + WALL_T, z: rows + 2.6, near: true, color: o.red },
  ];
  for (const c of corners) {
    const h = c.near ? 1.1 : 2.7;
    const tower = openBox(1.4, h, 1.4, mats.stone, c.near ? ['pz', 'py'] : c.z < 0 ? 'nz' : 'px');
    tower.position.set(c.x, baseY + h / 2, c.z);
    common.stone.push(tower);

    if (!c.near) {
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(1.05, 1.0, 4),
        new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.7, flatShading: true }),
      );
      roof.position.set(c.x, baseY + h + 0.5, c.z);
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      group.add(roof);
    }

    const poleH = c.near ? 1.3 : 5.2;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, poleH, 6), mats.pole);
    mast.position.set(c.x, baseY + h + poleH / 2, c.z);
    common.pole.push(mast);

    const cloth = new THREE.Mesh(
      new THREE.ConeGeometry(c.near ? 0.26 : 0.46, c.near ? 0.55 : 1.1, 4),
      new THREE.MeshStandardMaterial({
        color: c.color, emissive: c.color, emissiveIntensity: 0.35,
        roughness: 0.6, flatShading: true,
      }),
    );
    cloth.position.set(c.x, baseY + h + poleH - (c.near ? 0.18 : 0.35), c.z);
    cloth.castShadow = true;
    group.add(cloth);
  }

  // ---------------------------------------------------------------- 按段装配
  const commonGroup = bakeSegment(common, mats, 'stand-common');
  const backGroup = bakeSegment(back, mats, 'stand-back');
  const leftGroup = bakeSegment(left, mats, 'stand-left');
  const rightGroup = bakeSegment(right, mats, 'stand-right');
  group.add(commonGroup, backGroup, leftGroup, rightGroup);

  let hidden = 'front';
  const update = (yawDeg: number): void => {
    const near = nearestSegment(yawDeg);
    if (near === hidden) return; // 只在切换那一帧改 visible，别每帧写
    hidden = near;
    leftGroup.visible = near !== 'left';
    rightGroup.visible = near !== 'right';
    backGroup.visible = near !== 'back';
  };

  return {
    group,
    update,
    get hidden() { return hidden; },
  };
}
