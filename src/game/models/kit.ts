/**
 * 建模套件 —— 没有美术资产时，用"说明书"式声明把建筑搭出来。
 *
 * 每个模型就是一串 Node：`[box([2,1,2], STONE, [0,.5,0]), prism(...)]`。
 * 几何体按形状缓存、材质按颜色缓存，所以 200 栋房子也只占几份显存。
 * 将来换成真实 glTF，只需要把 ModelSpec 换成 loader，其余代码不动。
 */

import * as THREE from 'three';

export interface PaintOptions {
  rough?: number;
  metal?: number;
  emissive?: number;
  emissiveIntensity?: number;
  opacity?: number;
  flat?: boolean;
}

export type Vec3 = readonly [number, number, number];

export type Part =
  | { kind: 'box'; size: Vec3 }
  | { kind: 'prism'; size: Vec3 }
  | { kind: 'cyl'; rTop: number; rBottom: number; height: number; seg?: number }
  | { kind: 'cone'; radius: number; height: number; seg?: number }
  | { kind: 'sphere'; radius: number; seg?: number }
  | { kind: 'crystal'; radius: number; height: number }
  | { kind: 'plinth'; size: Vec3 };

export interface Node {
  part: Part;
  color: number;
  at?: Vec3;
  rot?: Vec3;
  paint?: PaintOptions;
}

export type ModelSpec = readonly Node[];

/** 调色板：低饱和大地色 + 少量高饱和点缀，俯视角下才分得清。 */
export const PAL = {
  wallLight: 0xd9cbb0,
  wallMid: 0xbfa87f,
  wallDark: 0x8c7a58,
  stone: 0x8e93a3,
  stoneDark: 0x5f6472,
  wood: 0x9a6b3f,
  woodDark: 0x6b4526,
  roofRed: 0xa8483c,
  roofBlue: 0x4b6f9a,
  roofGold: 0xc8a24c,
  metal: 0x9aa6b4,
  glow: 0x74e0ff,
  crystal: 0x8f6de0,
  grassTuft: 0x74a04f,
  snow: 0xeef3ff,
} as const;

const geometryCache = new Map<string, THREE.BufferGeometry>();
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

function partKey(part: Part): string {
  switch (part.kind) {
    case 'box':
    case 'prism':
    case 'plinth':
      return `${part.kind}:${part.size.join(',')}`;
    case 'cyl':
      return `cyl:${part.rTop},${part.rBottom},${part.height},${part.seg ?? 10}`;
    case 'cone':
      return `cone:${part.radius},${part.height},${part.seg ?? 8}`;
    case 'sphere':
      return `sphere:${part.radius},${part.seg ?? 8}`;
    case 'crystal':
      return `crystal:${part.radius},${part.height}`;
  }
}

type Triple = [number, number, number];

function pushQuad(tris: Triple[], a: Triple, b: Triple, c: Triple, d: Triple): void {
  // 两个三角形共用同一绕序，四点必须已按"从外侧看逆时针"给出
  tris.push(a, b, c, a, c, d);
}

/**
 * 三棱柱屋顶：脊线沿 X。
 * 6 个顶点手工枚举极易把绕序写反——反了会被正面剔除、整片屋顶凭空消失，
 * 所以这里统一走 pushQuad 的绕序约定。
 */
function makePrism(w: number, h: number, d: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const bl: Triple = [-hw, 0, -hd];
  const br: Triple = [-hw, 0, hd];
  const apL: Triple = [-hw, h, 0];
  const fl: Triple = [hw, 0, -hd];
  const fr: Triple = [hw, 0, hd];
  const apR: Triple = [hw, h, 0];

  const t: Triple[] = [];
  // 两端山墙（法线 ∓X）
  t.push(bl, br, apL, fl, apR, fr);
  // 前坡(+Z) 与 后坡(-Z)
  pushQuad(t, br, fr, apR, apL);
  pushQuad(t, fl, bl, apL, apR);
  // 底面（法线 -Y）
  pushQuad(t, bl, fl, fr, br);

  return fromTriangles(t);
}

/** 收分台基：底面 w×d，顶面按 inset 收窄，让建筑"压"在地图上。 */
function makePlinth(w: number, h: number, d: number, inset = 0.12): THREE.BufferGeometry {
  const ring = (a: number, c: number, y: number): Triple[] => [
    [-a, y, -c],
    [-a, y, c],
    [a, y, c],
    [a, y, -c],
  ];
  const bottom = ring(w / 2, d / 2, 0);
  const top = ring((w / 2) * (1 - inset), (d / 2) * (1 - inset), h);

  const t: Triple[] = [];
  pushQuad(t, top[0]!, top[1]!, top[2]!, top[3]!); // 顶面 +Y
  pushQuad(t, bottom[0]!, bottom[3]!, bottom[2]!, bottom[1]!); // 底面 -Y
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    pushQuad(t, bottom[i]!, bottom[j]!, top[j]!, top[i]!); // 侧面向外
  }
  return fromTriangles(t);
}

/** 晶体：八面体纵向拉长，抽卡经济体系里"资源"的统一视觉符号。 */
function makeCrystal(radius: number, height: number): THREE.BufferGeometry {
  const geo = new THREE.OctahedronGeometry(radius, 0);
  geo.scale(1, height / radius, 1);
  geo.computeVertexNormals();
  return geo;
}

function fromTriangles(tris: Triple[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

export function geometryFor(part: Part): THREE.BufferGeometry {
  const key = partKey(part);
  const cached = geometryCache.get(key);
  if (cached) return cached;

  let geo: THREE.BufferGeometry;
  switch (part.kind) {
    case 'box':
      geo = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
      break;
    case 'prism':
      geo = makePrism(part.size[0], part.size[1], part.size[2]);
      break;
    case 'plinth':
      geo = makePlinth(part.size[0], part.size[1], part.size[2]);
      break;
    case 'cyl':
      geo = new THREE.CylinderGeometry(part.rTop, part.rBottom, part.height, part.seg ?? 10, 1);
      break;
    case 'cone':
      geo = new THREE.ConeGeometry(part.radius, part.height, part.seg ?? 8);
      break;
    case 'sphere':
      geo = new THREE.IcosahedronGeometry(part.radius, part.seg ?? 1);
      break;
    case 'crystal':
      geo = makeCrystal(part.radius, part.height);
      break;
  }
  geometryCache.set(key, geo);
  return geo;
}

export function paint(color: number, options: PaintOptions = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${options.rough ?? 0.85}|${options.metal ?? 0}|${options.flat ?? true}|${
    options.opacity ?? 1
  }|${options.emissive ?? 0}`;
  const cached = materialCache.get(key);
  if (cached) return cached;

  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: options.rough ?? 0.85,
    metalness: options.metal ?? 0,
    flatShading: options.flat ?? true,
    transparent: (options.opacity ?? 1) < 1,
    opacity: options.opacity ?? 1,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1,
  });
  materialCache.set(key, mat);
  return mat;
}

// ---------------------------------------------------------------- 说明书原语

export const box = (size: Vec3, color: number, at: Vec3 = [0, 0, 0], paintOpts?: PaintOptions): Node => ({
  part: { kind: 'box', size },
  color,
  at,
  paint: paintOpts,
});

export const plinth = (size: Vec3, color: number, at: Vec3 = [0, 0, 0], paintOpts?: PaintOptions): Node => ({
  part: { kind: 'plinth', size },
  color,
  at,
  paint: paintOpts,
});

export const prism = (size: Vec3, color: number, at: Vec3 = [0, 0, 0], paintOpts?: PaintOptions): Node => ({
  part: { kind: 'prism', size },
  color,
  at,
  paint: paintOpts,
});

export const cyl = (
  size: readonly [number, number, number],
  color: number,
  at: Vec3 = [0, 0, 0],
  seg = 10,
  paintOpts?: PaintOptions,
): Node => ({
  part: { kind: 'cyl', rTop: size[0], rBottom: size[1], height: size[2], seg },
  color,
  at,
  paint: paintOpts,
});

export const cone = (
  size: readonly [number, number],
  color: number,
  at: Vec3 = [0, 0, 0],
  seg = 8,
  paintOpts?: PaintOptions,
): Node => ({
  part: { kind: 'cone', radius: size[0], height: size[1], seg },
  color,
  at,
  paint: paintOpts,
});

export const sphere = (
  radius: number,
  color: number,
  at: Vec3 = [0, 0, 0],
  detail = 1,
  paintOpts?: PaintOptions,
): Node => ({
  part: { kind: 'sphere', radius, seg: detail },
  color,
  at,
  paint: paintOpts,
});

export const crystal = (
  size: readonly [number, number],
  color: number,
  at: Vec3 = [0, 0, 0],
  paintOpts?: PaintOptions,
): Node => ({
  part: { kind: 'crystal', radius: size[0], height: size[1] },
  color,
  at,
  paint: paintOpts,
});

// ---------------------------------------------------------------- 装配

export function meshFor(node: Node): THREE.Mesh {
  const mesh = new THREE.Mesh(geometryFor(node.part), paint(node.color, node.paint));
  if (node.at) mesh.position.set(node.at[0], node.at[1], node.at[2]);
  if (node.rot) mesh.rotation.set(node.rot[0], node.rot[1], node.rot[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildModel(spec: ModelSpec): THREE.Group {
  const group = new THREE.Group();
  for (const node of spec) group.add(meshFor(node));
  return group;
}

// ---------------------------------------------------------------- 合并

const mergedCache = new Map<string, THREE.BufferGeometry>();

/**
 * 把一份说明书压成单个几何体（顶点色），供 InstancedMesh 使用。
 *
 * 一次 merge = 一次 draw call：三百棵树从 900 次降到 1 次。
 * 代价是顶点色带不走 emissive，所以发光物（晶簇）仍走 buildModel 逐个成组。
 */
export function mergeGeometry(key: string, spec: ModelSpec): THREE.BufferGeometry {
  const cached = mergedCache.get(key);
  if (cached) return cached;

  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const matrix = new THREE.Matrix4();
  const euler = new THREE.Euler();
  const tint = new THREE.Color();

  for (const node of spec) {
    const src = geometryFor(node.part);
    // 缓存里的几何体绝不能被就地变换：indexed 走 toNonIndexed（返回新实例），
    // 非 indexed 必须先 clone，否则第二份说明书会改坏第一份的缓存
    const work = src.index ? src.toNonIndexed() : src.clone();

    euler.set(node.rot?.[0] ?? 0, node.rot?.[1] ?? 0, node.rot?.[2] ?? 0);
    matrix.makeRotationFromEuler(euler);
    matrix.setPosition(node.at?.[0] ?? 0, node.at?.[1] ?? 0, node.at?.[2] ?? 0);
    work.applyMatrix4(matrix);

    const p = work.getAttribute('position');
    const n = work.getAttribute('normal');
    // Color 构造按 sRGB 读入并转成工作色空间，与 paint() 里的材质色同一口径
    tint.set(node.color);
    for (let i = 0; i < p.count; i++) {
      position.push(p.getX(i), p.getY(i), p.getZ(i));
      normal.push(n.getX(i), n.getY(i), n.getZ(i));
      color.push(tint.r, tint.g, tint.b);
    }
    work.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geo.computeBoundingSphere();
  mergedCache.set(key, geo);
  return geo;
}

/** 计算模型的水平包围尺寸，放置时用来判断"视觉上有没有超出格子"。 */
export function modelFootprint(spec: ModelSpec): { width: number; depth: number; height: number } {
  let w = 0;
  let d = 0;
  let h = 0;
  for (const node of spec) {
    const size = nodeSize(node.part);
    w = Math.max(w, Math.abs(node.at?.[0] ?? 0) + size[0] / 2);
    d = Math.max(d, Math.abs(node.at?.[2] ?? 0) + size[2] / 2);
    h = Math.max(h, (node.at?.[1] ?? 0) + size[1]);
  }
  return { width: w * 2, depth: d * 2, height: h };
}

function nodeSize(part: Part): Vec3 {
  switch (part.kind) {
    case 'box':
    case 'prism':
    case 'plinth':
      return part.size;
    case 'cyl':
      return [part.rBottom * 2, part.height, part.rBottom * 2];
    case 'cone':
      return [part.radius * 2, part.height, part.radius * 2];
    case 'sphere':
      return [part.radius * 2, part.radius * 2, part.radius * 2];
    case 'crystal':
      return [part.radius * 2, part.height, part.radius * 2];
  }
}
