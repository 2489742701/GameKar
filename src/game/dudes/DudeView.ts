/**
 * 小人的 3D 呈现 —— 一张竖起来的像素卡片，永远正对相机。
 *
 * **朝向**：素材默认朝右，往屏幕左走时要镜像。镜像走的是**贴图 UV**（`flipX`），
 * 不是翻 mesh —— 翻 mesh 还得连带处理法线、双面与影子。
 *
 * 为什么不是"翻就完了"：这批素材接近对称（run 帧 alpha 质心只偏左 0.92px / 16px，
 * 剪影左右对称度 0.917–0.969），所以镜像的收益是"看着顺"，不是"看着对不对"。
 * 这一点先量过再改的：`facing_probe` 逐帧统计过质心，不是拍脑袋。
 *
 * UV 写在各自己的几何体上，不动纹理的 offset/repeat：
 * 同风格的多个小人共用一张纹理，动纹理就是互相踩。
 */

import * as THREE from 'three';
import { BASE_ANIMS, KNOWN_ANIMS, type AnimName } from './anims';
import { atlasLayout, buildAtlas, frameRect, type Atlas, type AtlasLayout } from './atlas';
import type { DudePack } from './pack';
import type { DudeStyle } from './style';

export interface DudeAppearance {
  /** 世界单位身高：一格 = 1，0.7 就是"比一格矮一点" */
  height: number;
  /** 离地块顶面再抬多少，避免和地面贴脸 */
  lift: number;
}

export const DEFAULT_APPEARANCE: DudeAppearance = { height: 1.0, lift: 0.012 };

/** 帧号：单帧动画恒为 0；die 不循环，播到最后一帧停住。 */
/**
 * 一帧在图集里的 u 区间。`flipX` 把两头对调 —— 这就是"贴图镜像"的全部实现，
 * 抽成纯函数是为了能单测（DudeSprite 本身要 canvas，node 里造不出来）。
 */
export function frameUv(
  rect: { x: number; w: number },
  canvasWidth: number,
  flipX: boolean,
): { u0: number; u1: number } {
  const a = rect.x / canvasWidth;
  const b = (rect.x + rect.w) / canvasWidth;
  return flipX ? { u0: b, u1: a } : { u0: a, u1: b };
}

/**
 * 朝向判定（统一入口）：贴图默认朝右，往**屏幕左**走就镜像。
 *
 * 世界位移必须先投到相机的右向量上：相机能转，直接看 `dx` 的符号，
 * 转到 180° 之后"往左走"就成了"往右走"，小人会反着朝。
 * `deadzone` 让纯上下走（横向几乎不动）保持上次朝向，不然会左右抽。
 */
export function facingFlip(
  dx: number,
  dz: number,
  yawDeg: number,
  previous: boolean,
  deadzone = 0.012,
): boolean {
  const t = (yawDeg * Math.PI) / 180;
  const screenDx = dx * Math.cos(t) - dz * Math.sin(t);
  if (Math.abs(screenDx) < deadzone) return previous;
  return screenDx < 0;
}

export function frameOf(anim: AnimName, time: number, loop = true): number {
  const spec = KNOWN_ANIMS[anim];
  if (spec.frames <= 1) return 0;
  const raw = Math.floor(time * spec.fps);
  return loop ? raw % spec.frames : Math.min(raw, spec.frames - 1);
}

export class DudeSprite {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly uv: THREE.BufferAttribute;
  private stamp = '';
  private anim: AnimName = 'idle';
  /** 贴图是否左右镜像（默认朝右，往左走才镜像） */
  private flipX = false;
  private lastRect: { x: number; w: number } | null = null;

  constructor(
    private readonly pack: DudePack,
    private readonly atlas: Atlas,
    texture: THREE.Texture,
    appearance: DudeAppearance = DEFAULT_APPEARANCE,
  ) {
    // 素材一帧是 16x24，卡片要保住这个比例，不然人就变胖或变瘦
    const width = appearance.height * (pack.w / pack.h);

    this.geometry = new THREE.PlaneGeometry(width, appearance.height);
    this.uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // PlaneGeometry 是居中的，所以底边贴地要把身高抬一半
    this.mesh.position.y = appearance.height / 2 + appearance.lift;
    // 构造就定一帧：不写 UV 的话，几何体带着 PlaneGeometry 默认的 0..1，
    // 会先把整张图集拉扁在一张卡片上，直到下一次 update 才盖掉
    this.play('idle', 0);
  }

  get playing(): AnimName {
    return this.anim;
  }

  faceCamera(yawDeg: number): void {
    this.mesh.rotation.y = THREE.MathUtils.degToRad(yawDeg);
  }

  play(anim: AnimName, time: number, loop = true): void {
    this.anim = anim;
    const frame = frameOf(anim, time, loop);
    const next = `${anim}|${frame}`;
    if (next === this.stamp) return;
    this.stamp = next;

    const rect = frameRect(this.atlas.layout, this.pack, anim, frame);
    this.lastRect = rect;
    this.writeUv();
  }

  /**
   * 要不要把贴图左右镜像。统一从这里进 —— 矿工、士兵都调它，别各自写一套。
   * 变的那一帧立刻重写 UV，不然要等下次换帧才看出来。
   */
  setFlipX(flip: boolean): void {
    if (this.flipX === flip) return;
    this.flipX = flip;
    if (this.lastRect) this.writeUv();
  }

  get flipped(): boolean {
    return this.flipX;
  }

  private writeUv(): void {
    if (!this.lastRect) return;
    const { u0, u1 } = frameUv(this.lastRect, this.atlas.canvas.width, this.flipX);
    // PlaneGeometry 顶点序：左上、右上、左下、右下
    this.uv.setXY(0, u0, 1);
    this.uv.setXY(1, u1, 1);
    this.uv.setXY(2, u0, 0);
    this.uv.setXY(3, u1, 0);
    this.uv.needsUpdate = true;
  }

  moveTo(x: number, z: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
  }

  /** 每个小人有自己的几何体与材质，纹理是共享的，所以这里不碰纹理。 */
  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * 风格 → 图集与纹理的缓存：一个风格一张纹理。
 * 20 个小人如果是同一风格，显存里只有一份 208×24。
 */
export class DudeGallery {
  private readonly entries = new Map<string, { atlas: Atlas; texture: THREE.Texture }>();

  constructor(private readonly pack: DudePack) {}

  /**
   * 内容寻址：同一份长相 + 同一组动画才复用同一张纹理。
   * 只算长相不算动画集是不够的 —— 矿工和弓手要的动作不一样，混用会画到不存在的帧上。
   */
  static keyOf(style: DudeStyle, anims: readonly AnimName[]): string {
    return [style.base, style.head, style.face, ...Object.values(style.hex), '|', ...anims].join('|');
  }

  get styleCount(): number {
    return this.entries.size;
  }

  get layout(): AtlasLayout {
    return atlasLayout(this.pack);
  }

  /** 已烘的像素总量，用来判断"风格数是不是涨过头了"。 */
  get atlasPixels(): number {
    let n = 0;
    for (const { atlas } of this.entries.values()) n += atlas.canvas.width * atlas.canvas.height;
    return n;
  }

  acquire(style: DudeStyle, anims: readonly AnimName[] = BASE_ANIMS): { atlas: Atlas; texture: THREE.Texture } {
    const key = DudeGallery.keyOf(style, anims);
    const cached = this.entries.get(key);
    if (cached) return cached;

    const atlas = buildAtlas(this.pack, style, anims);
    const texture = new THREE.CanvasTexture(atlas.canvas);
    // 像素画：近邻采样 + 不要 mipmap，否则一缩放就糊成灰
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    const entry = { atlas, texture };
    this.entries.set(key, entry);
    return entry;
  }

  createSprite(style: DudeStyle, anims: readonly AnimName[] = BASE_ANIMS, appearance?: DudeAppearance): DudeSprite {
    const { atlas, texture } = this.acquire(style, anims);
    return new DudeSprite(this.pack, atlas, texture, appearance);
  }

  dispose(): void {
    for (const { texture } of this.entries.values()) texture.dispose();
    this.entries.clear();
  }
}
