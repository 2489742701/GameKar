/**
 * 建模套件 —— 没有美术资产时，用"说明书"式声明把建筑搭出来。
 *
 * 每个模型就是一串 Node：`[box([2,1,2], STONE, [0,.5,0]), prism(...)]`。
 * 几何体按形状缓存、材质按颜色缓存，所以 200 栋房子也只占几份显存。
 * 将来换成真实 glTF，只需要把 ModelSpec 换成 loader，其余代码不动。
 *
 * `at` 的锚点约定（现量，不是约定俗成；写错就会出现"件与件之间看得见缝"）：
 * - box / cyl / cone / sphere / crystal：at 是**中心** —— 想让底面贴地，`at.y = 高 / 2`
 * - plinth / prism：at 是**底面** —— 直接写它要坐落的那个高度
 * 两类混用时，`tests/geometry.test.ts` 的"没有悬空的件"那条会拦下来（每件必须贴地或压到别的件上）。
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
  | { kind: 'plinth'; size: Vec3 }
  /**
   * 布：一片挂在杆上的旗面，顶点随风摆动（不是刚体，必须单独走材质）。
   * `dir = -1` 是**镜像**而不是旋转 180°：旋转会把局部 +Z 翻到世界 -Z，
   * 两面旗就朝相反方向抖（实测就是"风向不一样"）；镜像只翻 X，风向仍是同一阵。
   */
  | { kind: 'flag'; width: number; height: number; dir?: number };

export interface Node {
  part: Part;
  color: number;
  at?: Vec3;
  rot?: Vec3;
  paint?: PaintOptions;
  /**
   * 绕 `pivot` 自转的角速度（弧度/秒，绕 Z 轴）。给了它，这件就不是静物：
   * `buildModel` 会给它包一层转轴 Group，视图每帧推进 `rotation.z`。
   * 只支持绕 Z，是因为现在的"活件"只有风车帆与齿轮，多一个轴就多一套约定；
   * 真需要绕 Y 的时候再加，别提前抽象。
   */
  spin?: number;
  /** 自转轴心（模型局部坐标）。帆板必须绕轮毂转，不能绕自己中心转。 */
  pivot?: Vec3;
  /** 挂在杆顶的布：它靠**上沿**挂住，不是被下面的东西托着。几何锁按这个判。 */
  hang?: boolean;
  /**
   * 可转炮台：带这个字段的件会被收进同一个转台 Group，轴心就是这个坐标。
   * 视图侧拿 `userData.turret` 转它去瞄敌人（炮管朝 +Z，所以 yaw = atan2(dx, dz)）。
   */
  turret?: Vec3;
  /**
   * 设计上就悬空的件（魔法塔中间那颗磁浮晶核）。
   *
   * 只有这一种情况该写它：件**本来就该浮在那儿**，不是"忘了接上去"。
   * 几何锁看到这个标记会放行，所以写它之前先问一句"这是故意的吗"。
   */
  float?: boolean;
}

/** 会自转的件：包在 pivot Group 里，`rotation.z` 每帧按 speed 推进。 */
export interface Spinner {
  group: THREE.Group;
  speed: number;
}

/** `Group.userData` 上挂 spinner 列表的键；视图侧只认这一个字符串。 */
export const SPINNERS = 'spinners';

/** `Group.userData` 上挂"可转炮台"的键。 */
export const TURRET = 'turret';

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
  /** 炮管用的深铁：比 metal 暗两档，压在木台/石堡上才分得出来 */
  iron: 0x666f80,
  glow: 0x74e0ff,
  crystal: 0x8f6de0,
  grassTuft: 0x74a04f,
  snow: 0xeef3ff,
  /** 帆布：比墙白一点、比雪黄一点，叠在木杆上不糊成一片 */
  canvas: 0xe4d8b8,
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
    case 'flag':
      return `flag:${part.width},${part.height},${part.dir ?? 1}`;
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

/**
 * 晶体：八面体纵向拉长，抽卡经济体系里"资源"的统一视觉符号。
 *
 * `height` 是**总高**（和 box/cyl/cone 一个口径）。这里踩过一次坑：
 * 八面体的 Y 半径是 radius，直接 `scale(1, height/radius, 1)` 得到的是
 * **±height**（总高 2×height），于是"高 0.52 的晶核"实际纵向 1.04，
 * 把魔法塔的楼板和檐口一起插穿 —— 而测试里看着它"被楼板托住"，一切正常。
 */
function makeCrystal(radius: number, height: number): THREE.BufferGeometry {
  const geo = new THREE.OctahedronGeometry(radius, 0);
  geo.scale(1, height / 2 / radius, 1);
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
    case 'flag': {
      // 细分够多才摆得动；锚点挪到**左上角**（贴杆那头），挂旗时 at 直接写杆顶
      const g = new THREE.PlaneGeometry(part.width, part.height, 10, 5);
      g.translate(part.width / 2, -part.height / 2, 0);
      // 往 -X 飘的那面用镜像，不用旋转（见 Part 上的注释：旋转会让风向反过来）
      if ((part.dir ?? 1) < 0) g.scale(-1, 1, 1);
      geo = g;
      break;
    }
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

// ---------------------------------------------------------------- 布

/**
 * 旗面的时间轴 —— 全场共用一份。
 *
 * 布料不能靠"整体转一下"糊弄：那样旗子是块硬纸板，转起来像块牌子。
 * 这里在顶点着色器里按 uv.x（0 = 贴杆那头，1 = 自由端）叠两道不同频率的正弦，
 * 越靠自由端甩得越大，顶点一动光照跟着动，看着才是布。
 */
const flagClock = { value: 0 };

/** 每帧调用一次（GameApp.draw）。传的是游戏时间，暂停/回放才对得上。 */
export function updateFlagTime(t: number): void {
  flagClock.value = t;
}

const flagMaterials = new Map<number, THREE.MeshStandardMaterial>();

function clothMaterial(color: number): THREE.MeshStandardMaterial {
  const hit = flagMaterials.get(color);
  if (hit) return hit;
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.92,
    metalness: 0,
    // 转 180° 挂的那面旗，背面朝外，必须双面
    side: THREE.DoubleSide,
    flatShading: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlagTime = flagClock;
    shader.vertexShader = `uniform float uFlagTime;
${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float hoist = clamp(uv.x, 0.0, 1.0);
      float amp = hoist * hoist;
      transformed.z += (sin(hoist * 6.5 - uFlagTime * 4.2) * 0.075
                      + sin(hoist * 2.7 - uFlagTime * 2.3) * 0.04) * amp;
      transformed.y += sin(hoist * 5.0 - uFlagTime * 3.4) * 0.022 * amp - amp * 0.035;`,
    );
  };
  // 不加这一句，three 可能把旗子和普通材质共用一份已编译程序，我们的顶点位移就不生效
  mat.customProgramCacheKey = () => 'gamekar-flag';
  flagMaterials.set(color, mat);
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

export const flag = (
  size: readonly [number, number],
  color: number,
  at: Vec3 = [0, 0, 0],
  dir: number = 1,
): Node => ({
  part: { kind: 'flag', width: size[0], height: size[1], dir },
  color,
  at,
  hang: true,
});

// ---------------------------------------------------------------- 装配

export function meshFor(node: Node): THREE.Mesh {
  const cloth = node.part.kind === 'flag';
  const mesh = new THREE.Mesh(geometryFor(node.part), cloth ? clothMaterial(node.color) : paint(node.color, node.paint));
  if (node.at) mesh.position.set(node.at[0], node.at[1], node.at[2]);
  if (node.rot) mesh.rotation.set(node.rot[0], node.rot[1], node.rot[2]);
  // 顶点是在着色器里动的，阴影贴图那一遍不跟着动 —— 投出来的是一块硬纸板影子，干脆不投
  mesh.castShadow = !cloth;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildModel(spec: ModelSpec): THREE.Group {
  const group = new THREE.Group();
  const spinners: Spinner[] = [];
  // 可转炮台：同一次装配里所有带 turret 的件共用一个转台（轴心取第一个写的那个）
  const turretPivot = spec.find((n) => n.turret)?.turret ?? null;
  const turret = turretPivot ? new THREE.Group() : null;
  if (turret && turretPivot) {
    turret.position.set(turretPivot[0], turretPivot[1], turretPivot[2]);
    group.add(turret);
  }
  for (const node of spec) {
    const mesh = meshFor(node);
    if (turret && turretPivot && node.turret) {
      // 件本身按绝对 at 摆，坐标系换成"相对轴心"
      const a = node.at ?? [0, 0, 0];
      mesh.position.set(a[0] - turretPivot[0], a[1] - turretPivot[1], a[2] - turretPivot[2]);
      turret.add(mesh);
      continue;
    }
    if (node.spin && node.pivot) {
      const pivot = new THREE.Group();
      pivot.position.set(node.pivot[0], node.pivot[1], node.pivot[2]);
      // 件本身仍然按绝对 at 摆，只是坐标系换成"相对轴心"
      mesh.position.set(
        (node.at?.[0] ?? 0) - node.pivot[0],
        (node.at?.[1] ?? 0) - node.pivot[1],
        (node.at?.[2] ?? 0) - node.pivot[2],
      );
      pivot.add(mesh);
      group.add(pivot);
      spinners.push({ group: pivot, speed: node.spin });
      continue;
    }
    group.add(mesh);
  }
  if (spinners.length > 0) group.userData[SPINNERS] = spinners;
  if (turret) group.userData[TURRET] = turret;
  return group;
}

/** 取一栋楼上的自转件；没有就是空数组（静物楼不需要特判）。 */
export function spinnersOf(group: THREE.Object3D): Spinner[] {
  return (group.userData[SPINNERS] as Spinner[] | undefined) ?? [];
}

/**
 * 沿 Y 缩放一栋楼时，要把底面顶回原位所需的下移量。
 *
 * 各楼最低点实测从 -0.54 到 0 不等（有裙、有斜撑、有埋进土的柱脚），
 * 所以"底面在 y=0，缩放原点天然就是地基"这个假设是假的：
 * 不补这一笔，进度 15% 的塔会比盖好的塔抬离地面 0.41，看着就是凭空悬着。
 */
export const keepBaseOffset = (minY: number, scaleY: number): number => minY * (1 - scaleY);

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
    case 'flag':
      return [part.width, part.height, 0.02];
  }
}
